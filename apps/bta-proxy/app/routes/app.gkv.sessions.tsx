import { requireGkvAdmin } from "~/lib/gkv/adminRequest.server";
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData, useLocation, useSubmit } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/lib/gkv/adminApi.server";
import { getEmbeddedSearchEntries } from "~/lib/gkv/embeddedPath";
import {
  formatCustomerSearchLabel,
  type CustomerSearchItem,
} from "~/lib/shopifyCustomerSearch";
import { searchCustomers } from "~/lib/shopifyCustomerSearch.server";
import { authenticate } from "~/shopify.server";

type SessionItem = {
  sessionId: string;
  customerId: string;
  deviceId: string;
  deviceName: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  sessionStatus: "active" | "revoked";
};

type LoaderData = {
  customerId: string;
  items: SessionItem[];
  activeCount: number;
  totalCount: number;
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
  customers?: CustomerSearchItem[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId")?.trim() || "";

  if (!customerId) {
    return json<LoaderData>({ customerId: "", items: [], activeCount: 0, totalCount: 0 });
  }

  try {
    const data = await callGkvAdminApi<{
      customerId: string;
      items: SessionItem[];
      activeCount: number;
      totalCount: number;
    }>(request, `/admin/sessions?customerId=${encodeURIComponent(customerId)}`);

    return json<LoaderData>({
      customerId,
      items: data.items,
      activeCount: data.activeCount,
      totalCount: data.totalCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "세션 정보를 불러오지 못했습니다.";
    return json<LoaderData>({
      customerId,
      items: [],
      activeCount: 0,
      totalCount: 0,
      error: message,
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");

    if (intent === "searchCustomer") {
      const auth = await authenticate.admin(request);
      const query = String(formData.get("query") || "").trim();
      if (!query) {
        return json<ActionData>({ ok: false, message: "검색어가 필요합니다." }, { status: 400 });
      }

      const customers = await searchCustomers(auth.admin, query);
      return json<ActionData>({ ok: true, customers });
    }

    const customerId = String(formData.get("customerId") || "").trim();

    if (!customerId) {
      return json<ActionData>({ ok: false, message: "customerId가 필요합니다." }, { status: 400 });
    }

    if (intent === "revoke") {
      const sessionId = String(formData.get("sessionId") || "");
      if (!sessionId) {
        return json<ActionData>({ ok: false, message: "sessionId가 필요합니다." }, { status: 400 });
      }

      await callGkvAdminApi<{ revokedCount: number }>(request, "/admin/sessions/revoke", {
        method: "POST",
        body: JSON.stringify({ customerId, sessionId }),
      });

      return json<ActionData>({ ok: true, message: "세션을 해제했습니다." });
    }

    if (intent === "revoke-all") {
      await callGkvAdminApi<{ revokedCount: number }>(request, "/admin/sessions/revoke-all", {
        method: "POST",
        body: JSON.stringify({ customerId }),
      });

      return json<ActionData>({ ok: true, message: "전체 세션을 해제했습니다." });
    }

    return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }

    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

export default function GkvSessionsPage() {
  const { customerId, items, activeCount, totalCount, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const searchFetcher = useFetcher<ActionData>();
  const submit = useSubmit();
  const location = useLocation();
  const embeddedSearchEntries = getEmbeddedSearchEntries(location.search);
  const [input, setInput] = useState(customerId);
  const [pickedCustomerLabel, setPickedCustomerLabel] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<CustomerSearchItem[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    setInput(customerId);
  }, [customerId]);

  useEffect(() => {
    if (!searchFetcher.data) return;
    if (searchFetcher.data.ok) {
      setSearchError(null);
      setSearchResults(searchFetcher.data.customers ?? []);
      return;
    }
    if (searchFetcher.data.message) {
      setSearchResults([]);
      setSearchError(searchFetcher.data.message);
    }
  }, [searchFetcher.data]);

  const handleLookupSubmit = () => {
    const formData = new FormData();
    if (input.trim()) {
      formData.set("customerId", input.trim());
    }
    for (const entry of embeddedSearchEntries) {
      formData.set(entry.name, entry.value);
    }
    submit(formData, { method: "get" });
  };

  const handleSearchCustomers = () => {
    setSearchError(null);
    if (!searchTerm.trim()) {
      setSearchError("검색어를 입력해주세요.");
      return;
    }
    setHasSearched(true);
    const formData = new FormData();
    formData.set("intent", "searchCustomer");
    formData.set("query", searchTerm.trim());
    searchFetcher.submit(formData, { method: "post" });
  };

  const handlePickCustomer = (customer: CustomerSearchItem) => {
    setInput(customer.id);
    setPickedCustomerLabel(formatCustomerSearchLabel(customer));
    setSearchResults([]);
  };

  const searchRows = useMemo(() => {
    if (!searchResults.length) return [];
    return searchResults.map((customer) => [
      formatCustomerSearchLabel(customer) || "-",
      customer.email || "-",
      customer.id,
      <Button key={`${customer.id}-select`} size="micro" onClick={() => handlePickCustomer(customer)}>
        Select
      </Button>,
    ]);
  }, [searchResults]);

  const rows = items.map((item) => [
    item.deviceId,
    item.deviceName ?? "-",
    item.platform ?? "-",
    item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : "-",
    item.sessionStatus === "active" ? (
      <Badge key={`${item.sessionId}-status`} tone="success">
        active
      </Badge>
    ) : (
      <Badge key={`${item.sessionId}-status`} tone="critical">
        revoked
      </Badge>
    ),
    <fetcher.Form key={`${item.sessionId}-revoke`} method="post">
      <input type="hidden" name="intent" value="revoke" />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="sessionId" value={item.sessionId} />
      <Button submit size="micro" tone="critical" disabled={item.sessionStatus !== "active"}>
        Revoke
      </Button>
    </fetcher.Form>,
  ]);

  return (
    <Page>
      <TitleBar title="GKV Sessions" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            Sessions
          </Text>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="revoke-all" />
            <input type="hidden" name="customerId" value={customerId} />
            <Button submit tone="critical" disabled={!customerId || activeCount === 0}>
              Revoke All
            </Button>
          </fetcher.Form>
        </InlineStack>

        <Card>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              handleLookupSubmit();
            }}
          >
            <BlockStack gap="200">
              <TextField
                label="Customer ID"
                autoComplete="off"
                value={input}
                onChange={(value) => {
                  setInput(value);
                  setPickedCustomerLabel(null);
                }}
                requiredIndicator
              />
              <InlineStack gap="200" blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  {pickedCustomerLabel
                    ? `Selected: ${pickedCustomerLabel}`
                    : "아래 검색으로 고객을 선택할 수 있습니다."}
                </Text>
              </InlineStack>
              <Button submit variant="primary">
                Search
              </Button>
            </BlockStack>
          </form>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Customer Search
            </Text>
            <InlineStack gap="200" blockAlign="center">
              <TextField
                label="Name / Email / Customer ID"
                value={searchTerm}
                onChange={setSearchTerm}
                autoComplete="off"
              />
              <Button
                onClick={handleSearchCustomers}
                loading={searchFetcher.state !== "idle"}
                disabled={searchFetcher.state !== "idle"}
              >
                Search
              </Button>
            </InlineStack>
            {searchError ? <Banner tone="critical">{searchError}</Banner> : null}
            {searchRows.length ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["Name", "Email", "Customer ID", "Action"]}
                rows={searchRows}
              />
            ) : hasSearched ? (
              <Text variant="bodySm" as="p" tone="subdued">
                검색 결과가 없습니다.
              </Text>
            ) : null}
          </BlockStack>
        </Card>

        <Card>
          <InlineStack align="space-between">
            <Text as="p" variant="bodyMd">
              Active: {activeCount}
            </Text>
            <Text as="p" variant="bodyMd">
              Total: {totalCount}
            </Text>
          </InlineStack>
          <Box paddingBlockStart="300">
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text"]}
              headings={["Device ID", "Device Name", "Platform", "Last Seen", "Status", "Action"]}
              rows={rows}
            />
          </Box>
        </Card>

        {error ? (
          <Card>
            <Box padding="300">
              <Text as="p" variant="bodyMd" tone="critical">
                {error}
              </Text>
            </Box>
          </Card>
        ) : null}

        {fetcher.data?.message ? (
          <Card>
            <Box padding="300">
              <Text as="p" variant="bodyMd" tone={fetcher.data.ok ? "success" : "critical"}>
                {fetcher.data.message}
              </Text>
            </Box>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
