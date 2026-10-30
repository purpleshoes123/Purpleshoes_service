import { useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useLoaderData, useSubmit } from "react-router";
import { BlockStack, Button, Card, DataTable, Page, Text, TextField } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import {
  getCustomerEntitlements,
  listLedgerEvents,
  type EntitlementType,
} from "~/domains/checkout/guideExtension";
import db from "~/db.server";
import { listLogs } from "~/domains/checkout/guideExtension/logStore";

type LoaderData = {
  customerId: string;
  entitlements: Record<string, string | null>;
  ledgerCounts: Record<string, number>;
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
    return json<LoaderData>({
      customerId: "",
      entitlements: {},
      ledgerCounts: {},
      logs: [],
    });
  }

  const entitlements = await getCustomerEntitlements(auth.admin, customerId);
  const types: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];
  const ledgerCounts: Record<string, number> = {};
  for (const type of types) {
    const events = await listLedgerEvents(auth.admin, { customerId, type });
    ledgerCounts[type] = events.length;
  }

  const logs = await listLogs(db, {
    filters: { shop: auth.session.shop, customerId },
    limit: 50,
  });

  return json<LoaderData>({
    customerId,
    entitlements,
    ledgerCounts,
    logs: logs.logs.map((log) => ({
      id: log.id,
      status: log.status,
      monthsDelta: log.monthsDelta,
      newExpiresAt: log.newExpiresAt ? log.newExpiresAt.toISOString() : null,
      createdAt: log.createdAt.toISOString(),
    })),
  });
};

export default function GuideEntitlementsPage() {
  const data = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const [input, setInput] = useState(data.customerId || "");

  const entitlementRows = useMemo(() => {
    const types = ["PDF", "VIDEO", "BUNDLE"];
    return types.map((type) => [
      type,
      data.entitlements[type] || "-",
      String(data.ledgerCounts[type] || 0),
    ]);
  }, [data.entitlements, data.ledgerCounts]);

  const logRows = useMemo(() => {
    return data.logs.map((log) => [
      log.status,
      String(log.monthsDelta),
      log.newExpiresAt || "-",
      log.createdAt,
    ]);
  }, [data.logs]);

  return (
    <Page title="Guide Entitlements">
      <TitleBar title="Guide Entitlements" />
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
              Entitlements
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "numeric"]}
              headings={["Type", "ExpiresAt", "Ledger Events"]}
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
