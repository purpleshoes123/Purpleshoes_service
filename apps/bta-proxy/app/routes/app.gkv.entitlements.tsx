import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
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
  Checkbox,
  DataTable,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import {
  getCustomerEntitlements,
  isActive,
  normalizeToKstEndOfDay,
  recomputeEntitlement,
  type EntitlementType,
  type RecomputeOutcome,
} from "~/domains/checkout/guideExtension";
import { createLog, listLogs } from "~/domains/checkout/guideExtension/logStore";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";
import { getEmbeddedSearchEntries } from "~/domains/guide-viewer/embeddedPath";
import {
  formatCustomerSearchLabel,
  type CustomerSearchItem,
} from "~/domains/members/shopifyCustomerSearch";
import { searchCustomers } from "~/domains/members/shopifyCustomerSearch.server.ts";
import { authenticate } from "~/shopify.server";

type PermissionStatus = "ACTIVE" | "EXPIRED" | "NONE" | "ERROR";
type SummaryStatus = "ACTIVE" | "EXPIRED" | "NONE" | "ERROR";

type CurrentPermissionItem = {
  type: EntitlementType;
  label: string;
  rawValue: string | null;
  expiresAtKst: string | null;
  status: PermissionStatus;
  accessScope: string;
  note: string;
};

type PermissionSummary = {
  status: SummaryStatus;
  activeLabels: string[];
  latestExpiresAtKst: string | null;
  accessibleScopes: string[];
};

type EntitlementItem = {
  customerId: string;
  guideId: string;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string;
  sourceOrderId: string | null;
  updatedAt: string;
};

type LogItem = {
  id: string;
  status: string;
  entitlementType: string;
  eventType: string;
  monthsDelta: number;
  newExpiresAt: string | null;
  createdAt: string;
  errorMessage: string | null;
};

type RecomputeResultItem = {
  type: string;
  baseExpiresAt?: string | null;
  netMonths?: number;
  newExpiresAt?: string | null;
  status: "SUCCESS" | "FAILED";
  outcome?: RecomputeOutcome | "FAILED_NO_CHANGE";
  error?: string;
};

type LoaderData = {
  customerId: string;
  currentPermissions: CurrentPermissionItem[];
  permissionSummary: PermissionSummary;
  legacyEntitlements: EntitlementItem[];
  logs: LogItem[];
  currentPermissionError?: string;
  legacyError?: string;
  logError?: string;
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
  customers?: CustomerSearchItem[];
  recomputeResults?: RecomputeResultItem[];
};

const ENTITLEMENT_TYPES: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];
const TYPE_LABELS: Record<EntitlementType, string> = {
  PDF: "PDF 가이드",
  VIDEO: "비디오 가이드",
  BUNDLE: "번들 가이드",
};

const LEGACY_BLOCKED_MESSAGE =
  "이 화면에서는 legacy 권한 지급/회수를 지원하지 않습니다. 현재 가이드킷 권한은 권한 재계산으로 관리하세요.";

function normalizeCustomerId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("gid://")) {
    return trimmed;
  }
  if (/^\d+$/.test(trimmed)) {
    return `gid://shopify/Customer/${trimmed}`;
  }
  return trimmed;
}

function isValidCustomerGid(value: string): boolean {
  return /^gid:\/\/shopify\/Customer\/\d+$/.test(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function addScope(scopes: Set<string>, scope: string) {
  if (scope.trim()) {
    scopes.add(scope);
  }
}

function buildCurrentPermissions(
  entitlements: Record<string, string | null>,
  now: Date,
): { items: CurrentPermissionItem[]; summary: PermissionSummary } {
  const baseItems = ENTITLEMENT_TYPES.map((type) => {
    const rawValue = entitlements[type] ?? null;
    if (!rawValue) {
      return {
        type,
        label: TYPE_LABELS[type],
        rawValue: null,
        expiresAtKst: null,
        status: "NONE" as PermissionStatus,
        accessScope: "-",
        note: "메타필드 권한 없음",
      };
    }

    try {
      const normalized = normalizeToKstEndOfDay(rawValue);
      return {
        type,
        label: TYPE_LABELS[type],
        rawValue,
        expiresAtKst: normalized,
        status: isActive(normalized, now) ? ("ACTIVE" as const) : ("EXPIRED" as const),
        accessScope: "-",
        note: rawValue === normalized ? "" : `원본: ${rawValue}`,
      };
    } catch {
      return {
        type,
        label: TYPE_LABELS[type],
        rawValue,
        expiresAtKst: null,
        status: "ERROR" as PermissionStatus,
        accessScope: "-",
        note: "만료일 값을 해석하지 못했습니다.",
      };
    }
  });

  const activeTypes = new Set(
    baseItems.filter((item) => item.status === "ACTIVE").map((item) => item.type),
  );
  const bundleActive = activeTypes.has("BUNDLE");

  const items = baseItems.map((item) => {
    if (item.type === "PDF") {
      if (item.status === "ACTIVE") {
        return { ...item, accessScope: "PDF 파일, 공유 가이드 카테고리" };
      }
      if (bundleActive) {
        return { ...item, accessScope: "번들 권한으로 PDF 파일 접근 가능" };
      }
      return item;
    }

    if (item.type === "VIDEO") {
      if (item.status === "ACTIVE") {
        return { ...item, accessScope: "비디오 파일, 공유 가이드 카테고리" };
      }
      if (bundleActive) {
        return { ...item, accessScope: "번들 권한으로 비디오 파일 접근 가능" };
      }
      return item;
    }

    if (item.status === "ACTIVE") {
      return {
        ...item,
        accessScope: "PDF 파일, 비디오 파일, 지도/장소 목록, 공유 가이드 카테고리",
      };
    }
    return item;
  });

  const activeItems = items.filter((item) => item.status === "ACTIVE");
  const expiredItems = items.filter((item) => item.status === "EXPIRED");
  const errorItems = items.filter((item) => item.status === "ERROR");
  const latestExpiresAtKst =
    activeItems
      .map((item) => item.expiresAtKst)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
  const accessibleScopes = new Set<string>();

  if (activeTypes.has("PDF") || bundleActive) {
    addScope(accessibleScopes, "PDF 파일");
  }
  if (activeTypes.has("VIDEO") || bundleActive) {
    addScope(accessibleScopes, "비디오 파일");
  }
  if (bundleActive) {
    addScope(accessibleScopes, "지도/장소 목록");
  }
  if (activeItems.length > 0) {
    addScope(accessibleScopes, "공유 가이드 카테고리");
  }

  const status: SummaryStatus =
    errorItems.length > 0
      ? "ERROR"
      : activeItems.length > 0
        ? "ACTIVE"
        : expiredItems.length > 0
          ? "EXPIRED"
          : "NONE";

  return {
    items,
    summary: {
      status,
      activeLabels: activeItems.map((item) => item.label),
      latestExpiresAtKst,
      accessibleScopes: Array.from(accessibleScopes),
    },
  };
}

function serializeLog(log: any): LogItem {
  return {
    id: log.id,
    status: log.status,
    entitlementType: log.entitlementType,
    eventType: log.eventType,
    monthsDelta: log.monthsDelta,
    newExpiresAt: log.newExpiresAt ? log.newExpiresAt.toISOString() : null,
    createdAt: log.createdAt.toISOString(),
    errorMessage: log.errorMessage ?? null,
  };
}

function emptySummary(): PermissionSummary {
  return {
    status: "NONE",
    activeLabels: [],
    latestExpiresAtKst: null,
    accessibleScopes: [],
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  const url = new URL(request.url);
  const rawCustomerId = url.searchParams.get("customerId")?.trim() || "";
  const customerId = rawCustomerId ? normalizeCustomerId(rawCustomerId) : "";

  if (!customerId) {
    return json<LoaderData>({
      customerId: "",
      currentPermissions: [],
      permissionSummary: emptySummary(),
      legacyEntitlements: [],
      logs: [],
    });
  }

  try {
    const auth = await authenticate.admin(request);
    const data: LoaderData = {
      customerId,
      currentPermissions: [],
      permissionSummary: emptySummary(),
      legacyEntitlements: [],
      logs: [],
    };

    try {
      const current = await getCustomerEntitlements(auth.admin, customerId);
      const built = buildCurrentPermissions(current, new Date());
      data.currentPermissions = built.items;
      data.permissionSummary = built.summary;
    } catch (error) {
      data.currentPermissionError =
        error instanceof Error ? error.message : "현재 가이드킷 권한을 불러오지 못했습니다.";
    }

    try {
      const legacyRes = await callGkvAdminApi<{ items: EntitlementItem[] }>(
        request,
        `/admin/entitlements?customerId=${encodeURIComponent(customerId)}`,
      );
      data.legacyEntitlements = legacyRes.items;
    } catch (error) {
      data.legacyError =
        error instanceof Error ? error.message : "이전 GKV 권한 기록을 불러오지 못했습니다.";
    }

    try {
      const logs = await listLogs(db, {
        filters: { shop: auth.session.shop, customerId },
        limit: 20,
      });
      data.logs = logs.logs.map(serializeLog);
    } catch (error) {
      data.logError =
        error instanceof Error ? error.message : "최근 권한 처리 로그를 불러오지 못했습니다.";
    }

    return json<LoaderData>(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "권한 정보를 불러오지 못했습니다.";
    return json<LoaderData>({
      customerId,
      currentPermissions: [],
      permissionSummary: emptySummary(),
      legacyEntitlements: [],
      logs: [],
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

    if (intent === "grant" || intent === "revoke") {
      return json<ActionData>({ ok: false, message: LEGACY_BLOCKED_MESSAGE }, { status: 410 });
    }

    if (intent === "recompute") {
      const auth = await authenticate.admin(request);
      const customerId = normalizeCustomerId(String(formData.get("customerId") || ""));
      if (!isValidCustomerGid(customerId)) {
        return json<ActionData>(
          { ok: false, message: "고객 ID는 Shopify Customer GID 또는 숫자 ID여야 합니다." },
          { status: 400 },
        );
      }

      const selectedTypes = formData
        .getAll("types")
        .map((value) => String(value))
        .filter((value): value is EntitlementType =>
          ENTITLEMENT_TYPES.includes(value as EntitlementType),
        );
      if (selectedTypes.length === 0) {
        return json<ActionData>(
          { ok: false, message: "재계산할 권한을 하나 이상 선택해 주세요." },
          { status: 400 },
        );
      }

      const reason = String(formData.get("reason") || "").trim() || "manual recompute by admin";
      const results: RecomputeResultItem[] = [];

      for (const type of selectedTypes) {
        try {
          const result = await recomputeEntitlement({
            admin: auth.admin,
            customerId,
            type,
            reason,
          });

          await createLog(db, {
            shop: auth.session.shop,
            topic: "ADMIN_ACTION",
            customerId,
            entitlementType: type,
            eventType: "RECOMPUTE",
            monthsDelta: 0,
            baseExpiresAt: result.baseExpiresAt,
            newExpiresAt: result.newExpiresAt,
            status: "SUCCESS",
            rawRef: reason,
          });

          results.push({
            type,
            baseExpiresAt: result.baseExpiresAt,
            netMonths: result.netMonths,
            newExpiresAt: result.newExpiresAt,
            status: "SUCCESS",
            outcome: result.outcome,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await createLog(db, {
            shop: auth.session.shop,
            topic: "ADMIN_ACTION",
            customerId,
            entitlementType: type,
            eventType: "RECOMPUTE",
            monthsDelta: 0,
            status: "FAILED",
            errorCode: "ADMIN_RECOMPUTE_FAILED",
            errorMessage: message,
            rawRef: reason,
          });

          results.push({
            type,
            status: "FAILED",
            outcome: "FAILED_NO_CHANGE",
            error: message,
          });
        }
      }

      const failedCount = results.filter((result) => result.status === "FAILED").length;
      return json<ActionData>({
        ok: failedCount === 0,
        message:
          failedCount === 0
            ? "권한 재계산을 완료했습니다."
            : `권한 재계산 중 ${failedCount}건이 실패했습니다.`,
        recomputeResults: results,
      });
    }

    return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }

    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

function summaryStatusLabel(status: SummaryStatus): string {
  if (status === "ACTIVE") {
    return "사용 가능";
  }
  if (status === "EXPIRED") {
    return "만료됨";
  }
  if (status === "ERROR") {
    return "확인 필요";
  }
  return "권한 없음";
}

function permissionStatusBadge(status: PermissionStatus) {
  if (status === "ACTIVE") {
    return <Badge tone="success">사용 가능</Badge>;
  }
  if (status === "EXPIRED") {
    return <Badge tone="attention">만료됨</Badge>;
  }
  if (status === "ERROR") {
    return <Badge tone="critical">오류</Badge>;
  }
  return <Badge>없음</Badge>;
}

function summaryStatusBadge(status: SummaryStatus) {
  if (status === "ACTIVE") {
    return <Badge tone="success">사용 가능</Badge>;
  }
  if (status === "EXPIRED") {
    return <Badge tone="attention">만료됨</Badge>;
  }
  if (status === "ERROR") {
    return <Badge tone="critical">확인 필요</Badge>;
  }
  return <Badge>권한 없음</Badge>;
}

function legacyStatusBadge(status: EntitlementItem["status"]) {
  return status === "ACTIVE" ? (
    <Badge tone="success">ACTIVE</Badge>
  ) : (
    <Badge tone="critical">REVOKED</Badge>
  );
}

export default function GkvEntitlementsPage() {
  const {
    customerId,
    currentPermissions,
    permissionSummary,
    legacyEntitlements,
    logs,
    currentPermissionError,
    legacyError,
    logError,
    error,
  } = useLoaderData<LoaderData>();
  const actionFetcher = useFetcher<ActionData>();
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
  const [selectedTypes, setSelectedTypes] = useState<EntitlementType[]>(ENTITLEMENT_TYPES);
  const [recomputeReason, setRecomputeReason] = useState("권한 상태 점검");

  useEffect(() => {
    setInput(customerId);
  }, [customerId]);

  useEffect(() => {
    if (!searchFetcher.data) {
      return;
    }
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
      formData.set("customerId", normalizeCustomerId(input.trim()));
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

  const toggleType = (type: EntitlementType) => {
    setSelectedTypes((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type],
    );
  };

  const searchRows = useMemo(() => {
    if (!searchResults.length) {
      return [];
    }
    return searchResults.map((customer) => [
      formatCustomerSearchLabel(customer) || "-",
      customer.email || "-",
      customer.id,
      <Button
        key={`${customer.id}-select`}
        size="micro"
        onClick={() => handlePickCustomer(customer)}
      >
        선택
      </Button>,
    ]);
  }, [searchResults]);

  const currentPermissionRows = currentPermissions.map((item) => [
    item.label,
    permissionStatusBadge(item.status),
    formatDateTime(item.expiresAtKst),
    item.accessScope,
    item.note || "-",
  ]);

  const legacyRows = legacyEntitlements.map((item) => [
    item.guideId,
    legacyStatusBadge(item.status),
    formatDateTime(item.expiresAt),
    item.sourceOrderId ?? "-",
    formatDateTime(item.updatedAt),
  ]);

  const logRows = logs.map((item) => [
    item.status === "SUCCESS" ? (
      <Badge tone="success">성공</Badge>
    ) : (
      <Badge tone="critical">실패</Badge>
    ),
    item.entitlementType,
    item.eventType,
    String(item.monthsDelta),
    formatDateTime(item.newExpiresAt),
    formatDateTime(item.createdAt),
    item.errorMessage ?? "-",
  ]);

  const recomputeRows = (actionFetcher.data?.recomputeResults ?? []).map((item) => {
    const resultBadge =
      item.status === "FAILED" ? (
        <Badge tone="critical">실패·변경 없음</Badge>
      ) : item.outcome === "CLEARED_AFTER_REFUND" ? (
        <Badge tone="success">환불 확인·권한 삭제 완료</Badge>
      ) : item.outcome === "NO_BASE_NO_CHANGE" ? (
        <Badge>구매 원장 없음·변경 없음</Badge>
      ) : (
        <Badge tone="success">재계산 완료</Badge>
      );

    return [
      TYPE_LABELS[item.type as EntitlementType] ?? item.type,
      resultBadge,
      formatDateTime(item.baseExpiresAt),
      item.netMonths !== undefined ? String(item.netMonths) : "-",
      formatDateTime(item.newExpiresAt),
      item.error ?? "-",
    ];
  });

  return (
    <Page>
      <TitleBar title="GKV 권한 관리" />
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg">
          GKV 권한 관리
        </Text>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              고객 조회
            </Text>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleLookupSubmit();
              }}
            >
              <BlockStack gap="200">
                <TextField
                  label="고객 ID"
                  autoComplete="off"
                  value={input}
                  onChange={(value) => {
                    setInput(value);
                    setPickedCustomerLabel(null);
                  }}
                  helpText="숫자 ID 또는 gid://shopify/Customer/... 형식을 입력할 수 있습니다."
                />
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {pickedCustomerLabel
                      ? `선택한 고객: ${pickedCustomerLabel}`
                      : "아래 검색으로 고객을 선택할 수 있습니다."}
                  </Text>
                </InlineStack>
                <Button submit variant="primary">
                  선택한 고객 조회
                </Button>
              </BlockStack>
            </form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              고객 검색
            </Text>
            <InlineStack gap="200" blockAlign="end">
              <TextField
                label="이름 / 이메일 / 고객 ID"
                value={searchTerm}
                onChange={setSearchTerm}
                autoComplete="off"
              />
              <Button
                onClick={handleSearchCustomers}
                loading={searchFetcher.state !== "idle"}
                disabled={searchFetcher.state !== "idle"}
              >
                고객 검색
              </Button>
            </InlineStack>
            {searchError ? <Banner tone="critical">{searchError}</Banner> : null}
            {searchRows.length ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["이름", "이메일", "고객 ID", "작업"]}
                rows={searchRows}
              />
            ) : hasSearched ? (
              <Text variant="bodySm" as="p" tone="subdued">
                검색 결과가 없습니다.
              </Text>
            ) : null}
          </BlockStack>
        </Card>

        {customerId ? (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  현재 가이드킷 권한
                </Text>
                {summaryStatusBadge(permissionSummary.status)}
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                이 영역은 현재 운영 기준인 Shopify customer metafield 기반 가이드킷 권한입니다. 고객
                앱과 마이페이지의 가이드 접근 판단에 사용되는 주 권한입니다.
              </Text>
              {currentPermissionError ? (
                <Banner tone="critical">{currentPermissionError}</Banner>
              ) : null}
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      현재 상태
                    </Text>
                    <Text as="p" variant="headingMd">
                      {summaryStatusLabel(permissionSummary.status)}
                    </Text>
                  </BlockStack>
                </Box>
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      활성 권한
                    </Text>
                    <Text as="p" variant="headingMd">
                      {permissionSummary.activeLabels.length
                        ? permissionSummary.activeLabels.join(", ")
                        : "-"}
                    </Text>
                  </BlockStack>
                </Box>
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      가장 긴 만료일
                    </Text>
                    <Text as="p" variant="headingMd">
                      {formatDateTime(permissionSummary.latestExpiresAtKst)}
                    </Text>
                  </BlockStack>
                </Box>
              </InlineGrid>
              <Text as="p" variant="bodySm" tone="subdued">
                실제 접근 가능 자료:{" "}
                {permissionSummary.accessibleScopes.length
                  ? permissionSummary.accessibleScopes.join(", ")
                  : "-"}
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["권한", "상태", "만료일", "실제 접근 범위", "비고"]}
                rows={currentPermissionRows}
              />
            </BlockStack>
          </Card>
        ) : null}

        {customerId ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                권한 재계산
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                구매/연장/환불 기록을 기준으로 고객의 가이드킷 권한을 다시 계산합니다. 문제가 있는
                고객을 점검하거나 환불 처리 후 권한 상태를 정리할 때 사용하세요.
              </Text>
              <actionFetcher.Form method="post">
                <BlockStack gap="200">
                  <input type="hidden" name="intent" value="recompute" />
                  <input type="hidden" name="customerId" value={customerId} />
                  {selectedTypes.map((type) => (
                    <input key={`${type}-selected`} type="hidden" name="types" value={type} />
                  ))}
                  <InlineStack gap="300">
                    {ENTITLEMENT_TYPES.map((type) => (
                      <Checkbox
                        key={type}
                        label={TYPE_LABELS[type]}
                        checked={selectedTypes.includes(type)}
                        onChange={() => toggleType(type)}
                      />
                    ))}
                  </InlineStack>
                  <TextField
                    name="reason"
                    label="재계산 사유"
                    value={recomputeReason}
                    onChange={setRecomputeReason}
                    autoComplete="off"
                    placeholder="예: 환불 후 권한 상태 점검"
                  />
                  <InlineStack>
                    <Button
                      submit
                      variant="primary"
                      loading={actionFetcher.state !== "idle"}
                      disabled={selectedTypes.length === 0 || actionFetcher.state !== "idle"}
                    >
                      선택 권한 재계산
                    </Button>
                  </InlineStack>
                </BlockStack>
              </actionFetcher.Form>
              {actionFetcher.data?.message ? (
                <Banner tone={actionFetcher.data.ok ? "success" : "critical"}>
                  {actionFetcher.data.message}
                </Banner>
              ) : null}
              {recomputeRows.length ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric", "text", "text"]}
                  headings={["권한", "결과", "기준 만료일", "순 개월", "새 만료일", "오류"]}
                  rows={recomputeRows}
                />
              ) : null}
            </BlockStack>
          </Card>
        ) : null}

        {customerId ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                이전 GKV 권한 기록
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                이 영역은 과거 DB 기반 권한 기록입니다. 현재 가이드킷 권한의 기준은 위의 "현재
                가이드킷 권한"입니다. 이 화면에서는 legacy 권한의 신규 지급/회수를 제공하지
                않습니다.
              </Text>
              {legacyError ? <Banner tone="critical">{legacyError}</Banner> : null}
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["Guide ID", "상태", "만료일", "Source Order", "최근 수정일"]}
                rows={legacyRows}
              />
            </BlockStack>
          </Card>
        ) : null}

        {customerId ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                최근 권한 처리 로그
              </Text>
              {logError ? <Banner tone="critical">{logError}</Banner> : null}
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "text", "text", "text"]}
                headings={["상태", "권한", "이벤트", "개월 수", "새 만료일", "처리 시각", "오류"]}
                rows={logRows}
              />
            </BlockStack>
          </Card>
        ) : null}

        {error ? (
          <Card>
            <Box padding="300">
              <Text as="p" variant="bodyMd" tone="critical">
                {error}
              </Text>
            </Box>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
