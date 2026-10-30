import { useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useLoaderData, useSubmit } from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import {
  getCustomerEntitlements,
  isActive,
  normalizeToKstEndOfDay,
  type EntitlementType,
} from "~/domains/checkout/guideExtension";
import db from "~/db.server";
import { listLogs } from "~/domains/checkout/guideExtension/logStore";

type LoaderData = {
  customerId: string;
  items: Array<{ type: string; expiresAtKst: string | null; status: string }>;
  logs: Array<{
    id: string;
    status: string;
    monthsDelta: number;
    newExpiresAt: string | null;
    createdAt: string;
  }>;
};

function normalizeCustomerId(value: string): string {
  if (value.startsWith("gid://")) {
    return value;
  }
  if (/^\d+$/.test(value)) {
    return `gid://shopify/Customer/${value}`;
  }
  return value;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const url = new URL(request.url);
  const customerParam = url.searchParams.get("customerId") || "";
  const customerId = customerParam ? normalizeCustomerId(customerParam) : "";

  if (!customerId) {
    return json<LoaderData>({ customerId: "", items: [], logs: [] });
  }

  const entitlements = await getCustomerEntitlements(auth.admin, customerId);
  const now = new Date();
  const types: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];
  const items = types.map((type) => {
    const rawValue = entitlements[type] ?? null;
    if (!rawValue) {
      return { type, expiresAtKst: null, status: "NONE" };
    }
    try {
      const normalized = normalizeToKstEndOfDay(rawValue);
      return {
        type,
        expiresAtKst: normalized,
        status: isActive(normalized, now) ? "ACTIVE" : "EXPIRED",
      };
    } catch {
      return { type, expiresAtKst: null, status: "NONE" };
    }
  });

  const logs = await listLogs(db, {
    filters: { shop: auth.session.shop, customerId },
    limit: 20,
  });

  return json<LoaderData>({
    customerId,
    items,
    logs: logs.logs.map((log) => ({
      id: log.id,
      status: log.status,
      monthsDelta: log.monthsDelta,
      newExpiresAt: log.newExpiresAt ? log.newExpiresAt.toISOString() : null,
      createdAt: log.createdAt.toISOString(),
    })),
  });
};

export default function GuideEntitlementsAdminPage() {
  const data = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const [input, setInput] = useState(data.customerId || "");
  const [selectedTypes, setSelectedTypes] = useState<EntitlementType[]>(["PDF", "VIDEO", "BUNDLE"]);
  const [reason, setReason] = useState("manual recompute by admin");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const entitlementRows = useMemo(() => {
    return data.items.map((item) => [item.type, item.expiresAtKst || "-", item.status]);
  }, [data.items]);

  const logRows = useMemo(() => {
    return data.logs.map((log) => [
      log.status,
      String(log.monthsDelta),
      log.newExpiresAt || "-",
      log.createdAt,
    ]);
  }, [data.logs]);

  const toggleType = (type: EntitlementType) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  const handleRecompute = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const normalizedInput =
        input.startsWith("gid://") && input.length > 0
          ? input
          : /^\d+$/.test(input)
            ? `gid://shopify/Customer/${input}`
            : input;
      const response = await fetch("/app/api/admin/guide-entitlements/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: normalizedInput,
          types: selectedTypes,
          reason,
        }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        throw new Error(payload.error?.message || "API error");
      }
      setResult(payload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page title="Guide Entitlements Admin">
      <TitleBar title="Guide Entitlements Admin" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">
              Customer Lookup
            </Text>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData();
                formData.set("customerId", input);
                submit(formData, { method: "get" });
              }}
            >
              <BlockStack gap="200">
                <TextField
                  label="Customer ID (gid:// or numeric)"
                  value={input}
                  onChange={(value) => setInput(value)}
                  autoComplete="off"
                />
                <Button submit>Search</Button>
              </BlockStack>
            </form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">
              Recompute
            </Text>
            <Text>Recompute uses ledger data only (no new events).</Text>
            <BlockStack gap="100">
              {(["PDF", "VIDEO", "BUNDLE"] as EntitlementType[]).map((type) => (
                <Checkbox
                  key={type}
                  label={type}
                  checked={selectedTypes.includes(type)}
                  onChange={() => toggleType(type)}
                />
              ))}
            </BlockStack>
            <TextField
              label="Reason"
              value={reason}
              onChange={(value) => setReason(value)}
              autoComplete="off"
            />
            <Button onClick={handleRecompute} disabled={loading}>
              {loading ? "Running..." : "Recompute"}
            </Button>
            {error ? <Banner status="critical">{error}</Banner> : null}
            {result ? (
              <Banner status="success">Recompute completed. Check results below.</Banner>
            ) : null}
          </BlockStack>
        </Card>

        {result?.results ? (
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">
                Recompute Results
              </Text>
              {result.results.map((entry: any) => (
                <Text key={entry.type}>
                  {entry.type}: {entry.status} {entry.newExpiresAt ? `→ ${entry.newExpiresAt}` : ""}
                  {entry.error ? ` (error: ${entry.error})` : ""}
                </Text>
              ))}
            </BlockStack>
          </Card>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">
              Entitlements
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={["Type", "ExpiresAt", "Status"]}
              rows={entitlementRows}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">
              Recent Logs
            </Text>
            <DataTable
              columnContentTypes={["text", "numeric", "text", "text"]}
              headings={["Status", "Months", "New ExpiresAt", "CreatedAt"]}
              rows={logRows}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
