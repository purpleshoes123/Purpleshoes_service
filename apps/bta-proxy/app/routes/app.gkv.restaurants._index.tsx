import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData, useLocation, useSubmit } from "react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";
import { getEmbeddedSearchEntries, withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";

type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
};

type AreaItem = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
};

type RestaurantItem = {
  id: string;
  name: string;
  area: { id: string; name: string; slug: string } | null;
  categories: Array<{ id: string; name: string; slug: string }>;
  veganRecommended: boolean;
  meatTypes: string[];
  address: string;
  photoUrl: string | null;
  photoThumbnailUrl: string | null;
  priority: number;
  isActive: boolean;
  updatedAt: string;
};

type LoaderData = {
  items: RestaurantItem[];
  categories: CategoryItem[];
  areas: AreaItem[];
  filters: {
    q: string;
    categoryIds: string;
    areaId: string;
    veganRecommended: string;
    meatTypes: string;
    isActive: string;
    sort: string;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
};

function buildQuery(request: Request) {
  const url = new URL(request.url);
  const params = new URLSearchParams();

  const q = url.searchParams.get("q")?.trim() || "";
  const categoryIds = url.searchParams.get("categoryIds")?.trim() || "";
  const areaId = url.searchParams.get("areaId")?.trim() || "";
  const veganRecommended = url.searchParams.get("veganRecommended")?.trim() || "";
  const meatTypes = url.searchParams.get("meatTypes")?.trim() || "";
  const isActive = url.searchParams.get("isActive")?.trim() || "";
  const sort = url.searchParams.get("sort")?.trim() || "priority";
  const page = Math.max(Number(url.searchParams.get("page") || "1") || 1, 1);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50") || 50, 1), 200);

  if (q) {
    params.set("q", q);
  }
  if (categoryIds) {
    params.set("categoryIds", categoryIds);
  }
  if (areaId) {
    params.set("areaId", areaId);
  }
  if (veganRecommended) {
    params.set("veganRecommended", veganRecommended);
  }
  if (meatTypes) {
    params.set("meatTypes", meatTypes);
  }
  if (isActive) {
    params.set("isActive", isActive);
  }
  if (sort) {
    params.set("sort", sort);
  }
  if (page > 1) {
    params.set("page", String(page));
  }
  if (limit !== 50) {
    params.set("limit", String(limit));
  }

  return {
    query: params.toString(),
    filters: {
      q,
      categoryIds,
      areaId,
      veganRecommended,
      meatTypes,
      isActive,
      sort,
    },
    pagination: {
      page,
      limit,
    },
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  const { query, filters, pagination } = buildQuery(request);

  try {
    const [restaurantsRes, categoriesRes, areasRes] = await Promise.all([
      callGkvAdminApi<{
        items: RestaurantItem[];
        totalCount: number;
        page: number;
        pageSize: number;
        hasPreviousPage: boolean;
        hasNextPage: boolean;
      }>(request, `/admin/restaurants${query ? `?${query}` : ""}`),
      callGkvAdminApi<{ items: CategoryItem[] }>(
        request,
        "/admin/restaurants/categories?includeInactive=true",
      ),
      callGkvAdminApi<{ items: AreaItem[] }>(
        request,
        "/admin/restaurants/areas?includeInactive=true",
      ),
    ]);

    return json<LoaderData>({
      items: restaurantsRes.items,
      categories: categoriesRes.items,
      areas: areasRes.items,
      filters,
      pagination: {
        page: restaurantsRes.page,
        pageSize: restaurantsRes.pageSize,
        totalCount: restaurantsRes.totalCount,
        hasPreviousPage: restaurantsRes.hasPreviousPage,
        hasNextPage: restaurantsRes.hasNextPage,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "맛집 목록을 불러오지 못했습니다.";
    return json<LoaderData>({
      items: [],
      categories: [],
      areas: [],
      filters,
      pagination: {
        page: pagination.page,
        pageSize: pagination.limit,
        totalCount: 0,
        hasPreviousPage: false,
        hasNextPage: false,
      },
      error: message,
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");

    if (intent !== "deactivate") {
      return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
    }

    const id = String(formData.get("id") || "");
    if (!id) {
      return json<ActionData>(
        { ok: false, message: "restaurant id가 필요합니다." },
        { status: 400 },
      );
    }

    await callGkvAdminApi<{ id: string }>(request, `/admin/restaurants/${id}`, {
      method: "DELETE",
    });

    return json<ActionData>({ ok: true, message: "맛집을 비활성화했습니다." });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }

    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

type BadgeTone = "success" | "critical" | "attention" | "info";

function formatBooleanFilter(value: string): string {
  if (value === "true") {
    return "Yes";
  }
  if (value === "false") {
    return "No";
  }
  return value;
}

function formatIdFilter(value: string, nameById: Map<string, string>): string {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => nameById.get(id) ?? id)
    .join(", ");
}

function RestaurantThumbnail({ item }: { item: RestaurantItem }) {
  if (item.photoThumbnailUrl) {
    return (
      <img
        src={item.photoThumbnailUrl}
        alt={`${item.name} thumbnail`}
        style={{
          width: "56px",
          height: "56px",
          objectFit: "cover",
          borderRadius: "6px",
          border: "1px solid #dfe3e8",
          flex: "0 0 56px",
        }}
      />
    );
  }

  return (
    <div
      aria-label="No restaurant photo"
      style={{
        width: "56px",
        height: "56px",
        borderRadius: "6px",
        border: "1px solid #dfe3e8",
        background: "#f6f6f7",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 56px",
      }}
    >
      <Text as="span" variant="bodySm" tone="subdued">
        No photo
      </Text>
    </div>
  );
}

function MetaBadgeList({
  label,
  values,
  tone,
  limit = 4,
}: {
  label: string;
  values: string[];
  tone?: BadgeTone;
  limit?: number;
}) {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        {label}: -
      </Text>
    );
  }

  const visible = normalized.slice(0, limit);
  const remaining = normalized.length - visible.length;

  return (
    <InlineStack gap="100" blockAlign="center" wrap>
      <Text as="span" variant="bodySm" tone="subdued">
        {label}:
      </Text>
      {visible.map((value) => (
        <Badge key={`${label}-${value}`} tone={tone}>
          {value}
        </Badge>
      ))}
      {remaining > 0 ? <Badge>+{remaining}</Badge> : null}
    </InlineStack>
  );
}

export default function GkvRestaurantsListPage() {
  const { items, categories, areas, filters, pagination, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const submit = useSubmit();
  const location = useLocation();
  const toInApp = useCallback(
    (path: string) => withEmbeddedSearch(path, location.search),
    [location.search],
  );
  const embeddedSearchEntries = useMemo(
    () => getEmbeddedSearchEntries(location.search),
    [location.search],
  );
  const [searchValue, setSearchValue] = useState(filters.q);
  const [categoryIdValue, setCategoryIdValue] = useState(filters.categoryIds);
  const [areaIdValue, setAreaIdValue] = useState(filters.areaId);
  const [veganRecommendedValue, setVeganRecommendedValue] = useState(filters.veganRecommended);
  const [meatTypesValue, setMeatTypesValue] = useState(filters.meatTypes);
  const [isActiveValue, setIsActiveValue] = useState(filters.isActive);
  const [sortValue, setSortValue] = useState(filters.sort);

  useEffect(() => {
    setSearchValue(filters.q);
    setCategoryIdValue(filters.categoryIds);
    setAreaIdValue(filters.areaId);
    setVeganRecommendedValue(filters.veganRecommended);
    setMeatTypesValue(filters.meatTypes);
    setIsActiveValue(filters.isActive);
    setSortValue(filters.sort);
  }, [filters]);

  const categoryOptions = [{ label: "전체", value: "" }].concat(
    categories
      .filter((item) => item.isActive)
      .map((item) => ({ label: item.name, value: item.id })),
  );

  const areaOptions = [{ label: "전체", value: "" }].concat(
    areas.filter((item) => item.isActive).map((item) => ({ label: item.name, value: item.id })),
  );

  const categoryNameById = useMemo(
    () => new Map(categories.map((item) => [item.id, item.name])),
    [categories],
  );
  const areaNameById = useMemo(() => new Map(areas.map((item) => [item.id, item.name])), [areas]);
  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (filters.q) {
      labels.push(`검색: ${filters.q}`);
    }
    if (filters.categoryIds) {
      labels.push(`카테고리: ${formatIdFilter(filters.categoryIds, categoryNameById)}`);
    }
    if (filters.areaId) {
      labels.push(`지역: ${areaNameById.get(filters.areaId) ?? filters.areaId}`);
    }
    if (filters.veganRecommended) {
      labels.push(`비건 추천: ${formatBooleanFilter(filters.veganRecommended)}`);
    }
    if (filters.meatTypes) {
      labels.push(`고기 종류: ${filters.meatTypes}`);
    }
    if (filters.isActive) {
      labels.push(`활성: ${formatBooleanFilter(filters.isActive)}`);
    }
    if (filters.sort && filters.sort !== "priority") {
      labels.push(`정렬: ${filters.sort}`);
    }
    return labels;
  }, [areaNameById, categoryNameById, filters]);
  const resetUrl = useMemo(() => {
    const params = new URLSearchParams();
    for (const entry of embeddedSearchEntries) {
      params.set(entry.name, entry.value);
    }
    const query = params.toString();
    return `/app/gkv/restaurants${query ? `?${query}` : ""}`;
  }, [embeddedSearchEntries]);
  const pendingDeactivateId =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("id") ?? "") : "";
  const hasActiveFilters = activeFilterLabels.length > 0;

  const addressTextStyle = {
    color: "#616161",
    fontSize: "13px",
    lineHeight: "20px",
    margin: 0,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as const;
  const metaWrapStyle = {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px 16px",
    alignItems: "center",
  } as const;
  const rowLayoutStyle = {
    display: "flex",
    alignItems: "flex-start",
    gap: "16px",
    flexWrap: "wrap",
  } as const;
  const rowBodyStyle = {
    flex: "1 1 360px",
    minWidth: 0,
  } as const;
  const rowActionsStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "8px",
    marginLeft: "auto",
    minWidth: "132px",
  } as const;
  const rowSeparatorStyle = {
    borderTop: "1px solid #e1e3e5",
  } as const;
  const thumbnailWrapStyle = {
    flex: "0 0 56px",
  } as const;

  function buildCleanFilterSubmission(form: HTMLFormElement): FormData {
    const formData = new FormData(form);
    for (const key of Array.from(formData.keys())) {
      const value = String(formData.get(key) ?? "").trim();
      if (!value) {
        formData.delete(key);
      }
    }
    formData.set("page", "1");
    formData.set("limit", String(pagination.pageSize));
    for (const entry of embeddedSearchEntries) {
      formData.set(entry.name, entry.value);
    }
    return formData;
  }

  function statusBadge(item: RestaurantItem) {
    return item.isActive ? (
      <Badge tone="success">ACTIVE</Badge>
    ) : (
      <Badge tone="critical">INACTIVE</Badge>
    );
  }

  function isDeactivatePending(item: RestaurantItem) {
    return pendingDeactivateId === item.id;
  }

  function renderRestaurantRow(item: RestaurantItem, index: number) {
    const isFirst = index === 0;
    const isLast = index === items.length - 1;
    const rowStyle = {
      ...(isFirst ? {} : rowSeparatorStyle),
      paddingTop: isFirst ? 0 : "16px",
      paddingBottom: isLast ? 0 : "16px",
    };

    return (
      <div key={item.id} style={rowStyle}>
        <div style={rowLayoutStyle}>
          <div style={thumbnailWrapStyle}>
            <RestaurantThumbnail item={item} />
          </div>
          <div style={rowBodyStyle}>
            <BlockStack gap="150">
              <InlineStack gap="150" blockAlign="center" wrap>
                <Text as="h2" variant="headingSm">
                  {item.name}
                </Text>
                {statusBadge(item)}
                {item.veganRecommended ? <Badge tone="info">VEGAN</Badge> : null}
              </InlineStack>
              <p title={item.address || "주소 없음"} style={addressTextStyle}>
                {item.address || "주소 없음"}
              </p>
              <div style={metaWrapStyle}>
                <Text as="span" variant="bodySm" tone="subdued">
                  Area: {item.area?.name ?? "-"}
                </Text>
                <MetaBadgeList
                  label="Categories"
                  values={item.categories.map((category) => category.name)}
                  tone="info"
                />
                <MetaBadgeList label="Meat" values={item.meatTypes} tone="attention" />
              </div>
            </BlockStack>
          </div>
          <div style={rowActionsStyle}>
            <Text as="p" variant="bodySm" tone="subdued">
              Priority {item.priority}
            </Text>
            <InlineStack gap="200" align="end" wrap={false}>
              <Button
                size="micro"
                url={toInApp(`/app/gkv/restaurants/${encodeURIComponent(item.id)}`)}
              >
                Edit
              </Button>
              {item.isActive ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="deactivate" />
                  <input type="hidden" name="id" value={item.id} />
                  <Button submit size="micro" tone="critical" loading={isDeactivatePending(item)}>
                    Deactivate
                  </Button>
                </fetcher.Form>
              ) : null}
            </InlineStack>
          </div>
        </div>
      </div>
    );
  }

  function renderActiveFilters() {
    if (!hasActiveFilters) {
      return (
        <Text as="p" variant="bodySm" tone="subdued">
          적용된 필터가 없습니다.
        </Text>
      );
    }

    return (
      <InlineStack gap="150" blockAlign="center" wrap>
        <Text as="span" variant="bodySm" tone="subdued">
          적용 필터:
        </Text>
        {activeFilterLabels.map((label) => (
          <Badge key={label}>{label}</Badge>
        ))}
      </InlineStack>
    );
  }

  const visibleStart =
    pagination.totalCount === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const visibleEnd =
    pagination.totalCount === 0
      ? 0
      : Math.min(pagination.page * pagination.pageSize, pagination.totalCount);

  function buildPageUrl(nextPage: number) {
    const params = new URLSearchParams();
    if (filters.q) {
      params.set("q", filters.q);
    }
    if (filters.categoryIds) {
      params.set("categoryIds", filters.categoryIds);
    }
    if (filters.areaId) {
      params.set("areaId", filters.areaId);
    }
    if (filters.veganRecommended) {
      params.set("veganRecommended", filters.veganRecommended);
    }
    if (filters.meatTypes) {
      params.set("meatTypes", filters.meatTypes);
    }
    if (filters.isActive) {
      params.set("isActive", filters.isActive);
    }
    if (filters.sort) {
      params.set("sort", filters.sort);
    }
    if (pagination.pageSize !== 50) {
      params.set("limit", String(pagination.pageSize));
    }
    if (nextPage > 1) {
      params.set("page", String(nextPage));
    }
    const query = params.toString();
    return toInApp(`/app/gkv/restaurants${query ? `?${query}` : ""}`);
  }

  return (
    <Page>
      <TitleBar title="GKV Restaurants" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <Text as="h1" variant="headingLg">
            Restaurants
          </Text>
          <InlineStack gap="200" wrap>
            <Button url={toInApp("/app/gkv/restaurants/categories")}>Manage Categories</Button>
            <Button url={toInApp("/app/gkv/restaurants/areas")}>Manage Areas</Button>
            <Button variant="primary" url={toInApp("/app/gkv/restaurants/new")}>
              New Restaurant
            </Button>
          </InlineStack>
        </InlineStack>

        <Card>
          <form
            method="get"
            onSubmit={(event) => {
              event.preventDefault();
              submit(buildCleanFilterSubmission(event.currentTarget), {
                method: "get",
              });
            }}
          >
            <BlockStack gap="300">
              {embeddedSearchEntries.map((entry) => (
                <input key={entry.name} type="hidden" name={entry.name} value={entry.value} />
              ))}
              <input type="hidden" name="page" value="1" />
              <input type="hidden" name="limit" value={String(pagination.pageSize)} />
              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <TextField
                  label="Search"
                  name="q"
                  autoComplete="off"
                  value={searchValue}
                  onChange={(value) => setSearchValue(value)}
                />
                <Select
                  label="Category"
                  name="categoryIds"
                  options={categoryOptions}
                  value={categoryIdValue}
                  onChange={(value) => setCategoryIdValue(value)}
                />
                <Select
                  label="Area"
                  name="areaId"
                  options={areaOptions}
                  value={areaIdValue}
                  onChange={(value) => setAreaIdValue(value)}
                />
              </InlineGrid>
              <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
                <Select
                  label="Vegan Recommended"
                  name="veganRecommended"
                  value={veganRecommendedValue}
                  onChange={(value) => setVeganRecommendedValue(value)}
                  options={[
                    { label: "전체", value: "" },
                    { label: "Yes", value: "true" },
                    { label: "No", value: "false" },
                  ]}
                />
                <TextField
                  label="Meat Types (csv)"
                  name="meatTypes"
                  autoComplete="off"
                  value={meatTypesValue}
                  onChange={(value) => setMeatTypesValue(value)}
                />
                <Select
                  label="Is Active"
                  name="isActive"
                  value={isActiveValue}
                  onChange={(value) => setIsActiveValue(value)}
                  options={[
                    { label: "전체", value: "" },
                    { label: "Yes", value: "true" },
                    { label: "No", value: "false" },
                  ]}
                />
                <Select
                  label="Sort"
                  name="sort"
                  value={sortValue}
                  onChange={(value) => setSortValue(value)}
                  options={[
                    { label: "priority", value: "priority" },
                    { label: "newest", value: "newest" },
                    { label: "name", value: "name" },
                  ]}
                />
              </InlineGrid>
              <InlineStack gap="200">
                <Button submit variant="primary">
                  Apply Filters
                </Button>
                <Button url={resetUrl} disabled={!hasActiveFilters}>
                  Reset
                </Button>
              </InlineStack>
              {renderActiveFilters()}
            </BlockStack>
          </form>
        </Card>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
              <Text as="p" variant="bodyMd" tone="subdued">
                {pagination.totalCount > 0
                  ? `${visibleStart}-${visibleEnd} / ${pagination.totalCount}`
                  : "0 / 0"}
              </Text>
              <InlineStack gap="200" blockAlign="center" wrap>
                <Button
                  disabled={!pagination.hasPreviousPage}
                  url={pagination.hasPreviousPage ? buildPageUrl(pagination.page - 1) : undefined}
                >
                  Previous
                </Button>
                <Text as="p" variant="bodyMd">
                  Page {pagination.page}
                </Text>
                <Button
                  disabled={!pagination.hasNextPage}
                  url={pagination.hasNextPage ? buildPageUrl(pagination.page + 1) : undefined}
                >
                  Next
                </Button>
              </InlineStack>
            </InlineStack>

            {items.length === 0 ? (
              <EmptyState
                heading="등록된 맛집이 없습니다"
                action={{
                  content: "New Restaurant",
                  url: toInApp("/app/gkv/restaurants/new"),
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>맛집을 등록해 주세요.</p>
              </EmptyState>
            ) : (
              <div>{items.map((item, index) => renderRestaurantRow(item, index))}</div>
            )}
          </BlockStack>
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
