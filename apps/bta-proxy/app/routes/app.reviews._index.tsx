import { useEffect, useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Form, useFetcher, useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Badge,
  BlockStack,
  Banner,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import {
  getEmbeddedSearchEntries,
  withEmbeddedSearch,
} from "~/lib/gkv/embeddedPath";
import {
  listAllReviews,
  type ReviewItem,
  type ReviewStatusFilter,
} from "~/lib/reviewService";

type ReviewTypeFilter = "all" | "admin" | "customer";

type LoaderData = {
  items: ReviewItem[];
  reviewTypeFilter: ReviewTypeFilter;
  statusFilter: ReviewStatusFilter;
  searchKeyword: string;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const shop = auth.session.shop;
  const url = new URL(request.url);
  const reviewTypeRaw = url.searchParams.get("reviewType");
  const reviewTypeFilter: ReviewTypeFilter =
    reviewTypeRaw === "admin" || reviewTypeRaw === "customer"
      ? reviewTypeRaw
      : "all";
  const statusRaw = (url.searchParams.get("status") || "").toUpperCase();
  const statusFilter: ReviewStatusFilter =
    statusRaw === "ACTIVE" || statusRaw === "DRAFT" || statusRaw === "UNKNOWN"
      ? statusRaw
      : "all";
  const searchKeyword = (url.searchParams.get("q") || "").trim();

  try {
    const result = await listAllReviews({
      shop,
      includeDraft: true,
      limit: 200,
      reviewType: reviewTypeFilter,
      statusFilter,
      searchQuery: searchKeyword || undefined,
    });
    return json<LoaderData>({
      items: result.items,
      reviewTypeFilter,
      statusFilter,
      searchKeyword,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json<LoaderData>({
      items: [],
      reviewTypeFilter,
      statusFilter,
      searchKeyword,
      error: message || "리뷰 조회 실패",
    });
  }
};

function formatSubmittedAt(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR");
}

function shortProductId(productId: string): string {
  const parts = productId.split("/").filter(Boolean);
  const last = parts.at(-1);
  if (productId.includes("/Product/") && last) return `.../Product/${last}`;
  if (productId.length <= 36) return productId;
  return `...${productId.slice(-32)}`;
}

function reviewStatusBadge(status: string) {
  const statusTone =
    status === "ACTIVE"
      ? "success"
      : status === "DRAFT"
        ? "warning"
        : "attention";
  return <Badge tone={statusTone}>{status}</Badge>;
}

function reviewTypeBadge(reviewType: ReviewItem["reviewType"]) {
  return (
    <Badge tone={reviewType === "admin" ? "info" : "new"}>{reviewType}</Badge>
  );
}

export default function AdminReviewsPage() {
  const loaderData = useLoaderData<LoaderData>();
  const navigate = useNavigate();
  const toggleFetcher = useFetcher<any>();
  const updateFetcher = useFetcher<any>();
  const deleteFetcher = useFetcher<any>();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const embeddedSearchEntries = useMemo(
    () => getEmbeddedSearchEntries(location.search),
    [location.search],
  );

  const [items, setItems] = useState<ReviewItem[]>(loaderData.items || []);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    loaderData.error || null,
  );
  const [reviewTypeFilter, setReviewTypeFilter] = useState<ReviewTypeFilter>(
    loaderData.reviewTypeFilter,
  );
  const [statusFilter, setStatusFilter] = useState<ReviewStatusFilter>(
    loaderData.statusFilter,
  );
  const [searchKeyword, setSearchKeyword] = useState<string>(
    loaderData.searchKeyword || "",
  );
  const [toggleTargetId, setToggleTargetId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [editingReviewId, setEditingReviewId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState<string>("");
  const [editAuthorDisplayName, setEditAuthorDisplayName] =
    useState<string>("");

  useEffect(() => {
    setItems(loaderData.items || []);
    setReviewTypeFilter(loaderData.reviewTypeFilter);
    setStatusFilter(loaderData.statusFilter);
    setSearchKeyword(loaderData.searchKeyword || "");
  }, [
    loaderData.items,
    loaderData.reviewTypeFilter,
    loaderData.statusFilter,
    loaderData.searchKeyword,
  ]);

  useEffect(() => {
    setErrorMessage(loaderData.error || null);
  }, [loaderData.error]);

  useEffect(() => {
    const payload = toggleFetcher.data as any;
    if (!payload) return;
    if (payload.ok) {
      const updated = payload.data?.item as ReviewItem | undefined;
      if (updated) {
        setItems((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );
      }
      setErrorMessage(null);
      setToggleTargetId(null);
      return;
    }
    if (payload.error?.message) {
      setErrorMessage(payload.error.message);
    }
    setToggleTargetId(null);
  }, [toggleFetcher.data]);

  useEffect(() => {
    const payload = updateFetcher.data as any;
    if (!payload) return;
    if (payload.ok) {
      const updated = payload.data?.item as ReviewItem | undefined;
      if (updated) {
        setItems((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );
      }
      setErrorMessage(null);
      setEditingReviewId(null);
      setEditBody("");
      setEditAuthorDisplayName("");
      return;
    }
    if (payload.error?.message) {
      setErrorMessage(payload.error.message);
    }
  }, [updateFetcher.data]);

  useEffect(() => {
    const payload = deleteFetcher.data as any;
    if (!payload) return;
    if (payload.ok) {
      const deletedId = payload.data?.deletedId as string | undefined;
      if (deletedId) {
        setItems((prev) => prev.filter((item) => item.id !== deletedId));
      }
      setErrorMessage(null);
      setDeleteTargetId(null);
      return;
    }
    if (payload.error?.message) {
      setErrorMessage(payload.error.message);
    }
    setDeleteTargetId(null);
  }, [deleteFetcher.data]);

  const editingItem = useMemo(
    () => items.find((item) => item.id === editingReviewId) || null,
    [items, editingReviewId],
  );

  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    if (loaderData.reviewTypeFilter !== "all") {
      labels.push(`Type: ${loaderData.reviewTypeFilter}`);
    }
    if (loaderData.statusFilter !== "all") {
      labels.push(`Status: ${loaderData.statusFilter}`);
    }
    if (loaderData.searchKeyword.trim()) {
      labels.push(`Search: ${loaderData.searchKeyword.trim()}`);
    }
    return labels;
  }, [
    loaderData.reviewTypeFilter,
    loaderData.searchKeyword,
    loaderData.statusFilter,
  ]);
  const resetUrl = toInApp("/app/reviews");

  const rowSeparatorStyle = {
    borderTop: "1px solid #e1e3e5",
  } as const;
  const rowLayoutStyle = {
    display: "flex",
    alignItems: "flex-start",
    gap: "16px",
    flexWrap: "wrap",
  } as const;
  const rowBodyStyle = {
    flex: "1 1 420px",
    minWidth: 0,
  } as const;
  const rowActionsStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "8px",
    marginLeft: "auto",
    minWidth: "150px",
  } as const;
  const oneLineStyle = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as const;
  const bodyPreviewStyle = {
    color: "#303030",
    display: "-webkit-box",
    fontSize: "13px",
    lineHeight: "20px",
    margin: 0,
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  } as const;
  const metaWrapStyle = {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px 16px",
    alignItems: "center",
  } as const;

  function submitToggle(item: ReviewItem, visible: boolean) {
    const formData = new FormData();
    formData.set("reviewId", item.id);
    formData.set("visible", String(visible));
    setToggleTargetId(item.id);
    toggleFetcher.submit(formData, {
      method: "post",
      action: toInApp("/app/reviews/toggle"),
    });
  }

  function openEditor(item: ReviewItem) {
    setEditingReviewId(item.id);
    setEditBody(item.body);
    setEditAuthorDisplayName(item.authorDisplayName || "");
  }

  function submitDelete(item: ReviewItem) {
    if (!window.confirm("Delete this review permanently? This cannot be undone.")) {
      return;
    }
    const formData = new FormData();
    formData.set("reviewId", item.id);
    setDeleteTargetId(item.id);
    deleteFetcher.submit(formData, {
      method: "post",
      action: toInApp("/app/reviews/delete"),
    });
  }

  function renderToggleActions(item: ReviewItem) {
    const isActive = item.status === "ACTIVE";
    const isUnknown = item.status === "UNKNOWN";
    const isLoading =
      toggleFetcher.state !== "idle" && toggleTargetId === item.id;

    if (isUnknown) {
      return (
        <>
          <Button
            size="micro"
            loading={isLoading}
            onClick={() => submitToggle(item, true)}
          >
            Publish
          </Button>
          <Button
            size="micro"
            tone="critical"
            loading={isLoading}
            onClick={() => submitToggle(item, false)}
          >
            Hide
          </Button>
        </>
      );
    }

    return (
      <Button
        size="micro"
        tone={isActive ? "critical" : undefined}
        loading={isLoading}
        onClick={() => submitToggle(item, !isActive)}
      >
        {isActive ? "Hide" : "Publish"}
      </Button>
    );
  }

  function renderActiveFilters() {
    if (activeFilterLabels.length === 0) {
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

  function renderReviewRow(item: ReviewItem, index: number) {
    const isFirst = index === 0;
    const isLast = index === items.length - 1;
    const isDeleting =
      deleteFetcher.state !== "idle" && deleteTargetId === item.id;
    const rowStyle = {
      ...(isFirst ? {} : rowSeparatorStyle),
      paddingTop: isFirst ? 0 : "16px",
      paddingBottom: isLast ? 0 : "16px",
    };

    return (
      <div key={item.id} style={rowStyle}>
        <div style={rowLayoutStyle}>
          <div style={rowBodyStyle}>
            <BlockStack gap="150">
              <InlineStack gap="150" blockAlign="center" wrap>
                <div title={item.label} style={oneLineStyle}>
                  <Text as="h2" variant="headingSm">
                    {item.label}
                  </Text>
                </div>
                {reviewTypeBadge(item.reviewType)}
                {reviewStatusBadge(item.status)}
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Author: {item.authorDisplayName || "-"}
              </Text>
              <p title={item.body} style={bodyPreviewStyle}>
                {item.body}
              </p>
              <div style={metaWrapStyle}>
                <Text as="span" variant="bodySm" tone="subdued">
                  Product:{" "}
                  <span title={item.productId}>
                    {shortProductId(item.productId)}
                  </span>
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  Submitted: {formatSubmittedAt(item.submittedAt)}
                </Text>
              </div>
            </BlockStack>
          </div>
          <div style={rowActionsStyle}>
            <InlineStack gap="100" align="end" wrap>
              <Button size="micro" onClick={() => openEditor(item)}>
                Edit
              </Button>
              {renderToggleActions(item)}
              <Button
                size="micro"
                tone="critical"
                loading={isDeleting}
                onClick={() => submitDelete(item)}
              >
                Delete
              </Button>
            </InlineStack>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Page>
      <TitleBar title="Reviews" />
      <BlockStack gap="500">
        {errorMessage ? (
          <Banner tone="critical" onDismiss={() => setErrorMessage(null)}>
            {errorMessage}
          </Banner>
        ) : null}

        <Modal
          open={Boolean(editingItem)}
          onClose={() => {
            if (updateFetcher.state !== "idle") return;
            setEditingReviewId(null);
            setEditBody("");
            setEditAuthorDisplayName("");
          }}
          title="Edit Review"
          primaryAction={{
            content: "Save",
            loading: updateFetcher.state !== "idle",
            disabled: !editingItem || editBody.trim().length < 20,
            onAction: () => {
              if (!editingItem) return;
              const formData = new FormData();
              formData.set("reviewId", editingItem.id);
              formData.set("body", editBody.trim());
              formData.set("authorDisplayName", editAuthorDisplayName.trim());
              formData.set("currentStatus", editingItem.status);
              updateFetcher.submit(formData, {
                method: "post",
                action: toInApp("/app/reviews/update"),
              });
            },
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => {
                if (updateFetcher.state !== "idle") return;
                setEditingReviewId(null);
                setEditBody("");
                setEditAuthorDisplayName("");
              },
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p" variant="bodySm" tone="subdued">
                {editingItem
                  ? `${editingItem.label} (${editingItem.reviewType})`
                  : ""}
              </Text>
              <TextField
                label="Body"
                value={editBody}
                onChange={setEditBody}
                multiline={4}
                autoComplete="off"
                helpText="Enter at least 20 characters."
              />
              <TextField
                label="Author Display Name"
                value={editAuthorDisplayName}
                onChange={setEditAuthorDisplayName}
                placeholder="Operations"
                autoComplete="off"
              />
            </BlockStack>
          </Modal.Section>
        </Modal>

        <Card>
          <BlockStack gap="400">
            <InlineStack
              align="space-between"
              blockAlign="center"
              gap="300"
              wrap
            >
              <Text as="h2" variant="headingMd">
                All Reviews
              </Text>
              <Button variant="primary" onClick={() => navigate(toInApp("/app/reviews/admin"))}>
                Create Admin Review
              </Button>
            </InlineStack>
            <Form method="get">
              {embeddedSearchEntries.map((entry) => (
                <input
                  key={entry.name}
                  type="hidden"
                  name={entry.name}
                  value={entry.value}
                />
              ))}
              <BlockStack gap="300">
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  <Select
                    label="Review Type"
                    name="reviewType"
                    options={[
                      { label: "All", value: "all" },
                      { label: "Admin", value: "admin" },
                      { label: "Customer", value: "customer" },
                    ]}
                    value={reviewTypeFilter}
                    onChange={(value) =>
                      setReviewTypeFilter(value as ReviewTypeFilter)
                    }
                  />
                  <Select
                    label="Status"
                    name="status"
                    options={[
                      { label: "All", value: "all" },
                      { label: "Active", value: "ACTIVE" },
                      { label: "Draft", value: "DRAFT" },
                      { label: "Unknown", value: "UNKNOWN" },
                    ]}
                    value={statusFilter}
                    onChange={(value) =>
                      setStatusFilter(value as ReviewStatusFilter)
                    }
                  />
                  <TextField
                    label="Search"
                    name="q"
                    value={searchKeyword}
                    onChange={setSearchKeyword}
                    autoComplete="off"
                    placeholder="Label, body, author, product ID, status"
                  />
                </InlineGrid>
                <InlineStack gap="200" wrap>
                  <Button submit variant="primary">
                    Apply
                  </Button>
                  <Button onClick={() => navigate(resetUrl)} variant="secondary">
                    Reset
                  </Button>
                </InlineStack>
                {renderActiveFilters()}
              </BlockStack>
            </Form>
            <Text as="p" variant="bodySm" tone="subdued">
              Total {items.length} reviews
            </Text>
            {items.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                등록된 리뷰가 없습니다.
              </Text>
            ) : (
              <div>
                {items.map((item, index) => renderReviewRow(item, index))}
              </div>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
