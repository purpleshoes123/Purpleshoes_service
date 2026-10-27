import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { ErrorCode } from "~/lib/errors";
import { logEvent } from "~/lib/logEvent";
import { getAdminApiClient } from "~/lib/shopifyAdmin";

export const REVIEW_METAOBJECT_TYPE = "product_text_review";
const FALLBACK_MAX = 200;
const METAOBJECT_FIELD_ERROR_PATTERNS = [
  "Field 'status' doesn't exist on type 'Metaobject'",
];
const METAOBJECT_INPUT_ERROR_PATTERNS = [
  "Field 'status' doesn't exist on type 'MetaobjectCreateInput'",
  "Field 'status' doesn't exist on type 'MetaobjectUpdateInput'",
  "Field is not defined on MetaobjectCreateInput",
  "Field is not defined on MetaobjectUpdateInput",
];
const METAOBJECT_CAPABILITY_INPUT_ERROR_PATTERNS = [
  "Field 'capabilities' doesn't exist on type 'MetaobjectUpdateInput'",
  "Field is not defined on MetaobjectUpdateInput",
];
const METAOBJECT_CAPABILITY_FIELD_ERROR_PATTERNS = [
  "Field 'capabilities' doesn't exist on type 'Metaobject'",
];
const METAOBJECT_CREATED_AT_FIELD_ERROR_PATTERNS = [
  "Field 'createdAt' doesn't exist on type 'Metaobject'",
];
let metaobjectCreatedAtFieldSupported: boolean | null = null;
export const FIELD_KEYS = {
  product: "product",
  reviewType: "review_type",
  body: "body",
  label: "label",
  order: "order",
  customer: "customer",
  authorDisplayName: "author_display_name",
  source: "source",
  submittedAt: "submitted_at",
} as const;

/**
 * Placement is stored in the existing `source` metafield. Adding a new
 * metaobject field would otherwise require a separate Shopify schema change.
 */
export const REVIEW_PLACEMENT = {
  homepage: "ps:homepage",
  product: "ps:product",
} as const;
export type ReviewPlacement = keyof typeof REVIEW_PLACEMENT;

export type ReviewType = "customer" | "admin";
export type ReviewStatusFilter = "all" | "ACTIVE" | "DRAFT" | "UNKNOWN";

export type ReviewItem = {
  id: string;
  productId: string;
  orderId?: string | null;
  customerId?: string | null;
  reviewType: ReviewType;
  body: string;
  label: string;
  authorDisplayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  country?: string | null;
  submittedAt: string | null;
  createdAt?: string | null;
  source?: string | null;
  status: string;
};

export type CustomerOrderReviewStatusItem = {
  orderId: string;
  reviewed: boolean;
  canEdit: boolean;
  review: {
    id: string;
    productId: string;
    reviewType: ReviewType;
    body: string;
    label: string;
    authorDisplayName: string | null;
    submittedAt: string | null;
    status: string;
  } | null;
};

export type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export type ReviewServiceErrorDetails = Record<string, unknown>;

export class ReviewServiceError extends Error {
  code: ErrorCode;
  details?: ReviewServiceErrorDetails;

  constructor(
    code: ErrorCode,
    message: string,
    details?: ReviewServiceErrorDetails
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function hasGraphqlError(
  errors: Array<{ message: string }> | undefined,
  patterns: string[]
): boolean {
  if (!errors || errors.length === 0) return false;
  return errors.some((error) =>
    patterns.some((pattern) => error.message.includes(pattern))
  );
}

function hasMetaobjectStatusInputError(
  errors: Array<{ message: string }> | undefined,
  inputType: "create" | "update"
): boolean {
  if (!errors || errors.length === 0) return false;
  const inputToken =
    inputType === "create" ? "metaobjectcreateinput" : "metaobjectupdateinput";
  return errors.some(
    (error) => {
      const message = error.message.toLowerCase();
      return message.includes("status") && message.includes(inputToken);
    }
  );
}

function isStatusInputUnsupportedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    (lower.includes("metaobjectcreateinput") && lower.includes("status")) ||
    (lower.includes("metaobjectupdateinput") && lower.includes("status"))
  );
}

function hasMetaobjectCapabilityInputError(
  errors: Array<{ message: string }> | undefined
): boolean {
  if (!errors || errors.length === 0) return false;
  return errors.some((error) => {
    const lower = error.message.toLowerCase();
    return lower.includes("metaobjectupdateinput") && lower.includes("capabilities");
  });
}

function buildPad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function buildCustomerLabel(orderId: string): string {
  return `customer-${orderId}`;
}

export function buildAdminLabel(dateKeyYYYYMMDD: string, seq: number): string {
  return `admin-${dateKeyYYYYMMDD}-${buildPad2(seq)}`;
}

function escapeQueryValue(value: string): string {
  return value.replace(/"/g, "\\\"");
}

function normalizeGid(value: string, type: "Product" | "Order" | "Customer") {
  if (!value) return value;
  if (value.startsWith("gid://")) return value;
  if (/^\d+$/.test(value)) {
    return `gid://shopify/${type}/${value}`;
  }
  return value;
}

/**
 * Customer-facing identity fields must never fall back to Shopify references,
 * numeric IDs, or the internal customer review label format.
 */
export function sanitizePublicIdentityValue(
  value: string | null | undefined,
  internalIds: Array<string | null | undefined> = []
): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  if (
    /gid:\/\/shopify\//i.test(normalized) ||
    /^(?:customer|order)-/i.test(normalized) ||
    /^\d+$/.test(normalized)
  ) {
    return null;
  }

  const lowerValue = normalized.toLowerCase();
  const matchesInternalId = internalIds.some((internalId) => {
    const candidate = internalId?.trim();
    if (!candidate) return false;

    const lowerCandidate = candidate.toLowerCase();
    const rawId = candidate.split("/").pop()?.toLowerCase();
    return lowerValue === lowerCandidate || Boolean(rawId && lowerValue === rawId);
  });

  return matchesInternalId ? null : normalized;
}

export function buildPublicAuthorDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string | null {
  const safeFirstName = sanitizePublicIdentityValue(firstName);
  const safeLastName = sanitizePublicIdentityValue(lastName);
  const lastInitial = safeLastName
    ? `${Array.from(safeLastName)[0]}.`
    : null;

  return [safeFirstName, lastInitial].filter(Boolean).join(" ") || null;
}

function mapFields(
  fields: Array<{ key: string; value: string }>
): Record<string, string> {
  const fieldMap: Record<string, string> = {};
  for (const field of fields) {
    fieldMap[field.key] = field.value;
  }
  return fieldMap;
}

function normalizeReviewStatus(status: string | null | undefined): string {
  if (!status) return "UNKNOWN";
  return status.toUpperCase();
}

function parseReviewItem(node: {
  id: string;
  status?: string | null;
  createdAt?: string | null;
  capabilities?: {
    publishable?: {
      status?: string | null;
    } | null;
  } | null;
  fields: Array<{ key: string; value: string }>;
}): ReviewItem | null {
  if (!node?.id || !node.fields) {
    return null;
  }

  const fieldMap = mapFields(node.fields);
  const productId = fieldMap[FIELD_KEYS.product];
  const orderId = fieldMap[FIELD_KEYS.order] || null;
  const customerId = fieldMap[FIELD_KEYS.customer] || null;
  const reviewType = fieldMap[FIELD_KEYS.reviewType] as ReviewType | undefined;
  const body = fieldMap[FIELD_KEYS.body];
  const label = fieldMap[FIELD_KEYS.label];

  if (!productId || !reviewType || !body || !label) {
    return null;
  }

  const authorDisplayName = fieldMap[FIELD_KEYS.authorDisplayName] || null;
  const submittedAt =
    fieldMap[FIELD_KEYS.submittedAt] || node.createdAt || null;
  // Prefer publishable capability status because it reflects storefront visibility.
  // Some shops return legacy `status` that can stay DRAFT while capability is ACTIVE.
  const rawStatus =
    node.capabilities?.publishable?.status || node.status;

  return {
    id: node.id,
    productId,
    orderId,
    customerId,
    reviewType,
    body,
    label,
    authorDisplayName: sanitizePublicIdentityValue(authorDisplayName, [
      orderId,
      customerId,
    ]),
    firstName: null,
    lastName: null,
    country: null,
    submittedAt,
    createdAt: node.createdAt || null,
    source: fieldMap[FIELD_KEYS.source] || null,
    status: normalizeReviewStatus(rawStatus),
  };
}

async function resolveAdmin(shop: string): Promise<AdminApiContext> {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      "Shopify Admin API 세션을 찾을 수 없습니다.",
      { shop }
    );
  }
  return admin;
}

/**
 * A product reference remains required by the existing Shopify review
 * metaobject definition. Homepage reviews never use this reference in the
 * storefront; it is only an internal anchor.
 */
export async function resolveHomepageReviewAnchorProductId(
  shop: string
): Promise<string> {
  const admin = await resolveAdmin(shop);
  const response = await admin.graphql(`
    query getHomepageReviewAnchorProduct {
      products(first: 1, query: "status:active", sortKey: CREATED_AT) {
        nodes { id }
      }
    }
  `);
  if (!response.ok) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `Shopify Admin API request failed with status ${response.status}`
    );
  }
  const payload = (await response.json()) as {
    data?: { products?: { nodes?: Array<{ id?: string | null }> } };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `GraphQL errors: ${payload.errors.map((error) => error.message).join(", ")}`
    );
  }
  const productId = payload.data?.products?.nodes?.[0]?.id;
  if (!productId) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_INVALID_INPUT,
      "메인페이지 리뷰를 연결할 활성 상품을 찾을 수 없습니다."
    );
  }
  return productId;
}

async function fetchMetaobjects(params: {
  admin: AdminApiContext;
  query?: string;
  first: number;
  after?: string | null;
}): Promise<{ nodes: Array<any>; pageInfo: PageInfo }> {
  const LIST_QUERY_WITH_STATUS_AND_CAPABILITY = `
    query listReviewMetaobjects($type: String!, $first: Int!, $after: String, $query: String) {
      metaobjects(type: $type, first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            createdAt
            status
            capabilities {
              publishable {
                status
              }
            }
            fields { key value }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const LIST_QUERY_WITH_CAPABILITY = `
    query listReviewMetaobjects($type: String!, $first: Int!, $after: String, $query: String) {
      metaobjects(type: $type, first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            createdAt
            capabilities {
              publishable {
                status
              }
            }
            fields { key value }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const LIST_QUERY_WITH_STATUS = `
    query listReviewMetaobjects($type: String!, $first: Int!, $after: String, $query: String) {
      metaobjects(type: $type, first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            createdAt
            status
            fields { key value }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const LEGACY_LIST_QUERY = `
    query listReviewMetaobjects($type: String!, $first: Int!, $after: String, $query: String) {
      metaobjects(type: $type, first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            createdAt
            fields { key value }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const variables = {
    type: REVIEW_METAOBJECT_TYPE,
    first: params.first,
    after: params.after ?? null,
    query: params.query,
  };
  type ListPayload = {
    data?: {
      metaobjects?: {
        edges?: Array<{ node: any }>;
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      };
    };
    errors?: Array<{ message: string }>;
  };
  const executeListQuery = async (queryText: string): Promise<ListPayload> => {
    const response = await params.admin.graphql(queryText, { variables });
    if (!response.ok) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        `Shopify Admin API request failed with status ${response.status}`
      );
    }
    return (await response.json()) as ListPayload;
  };
  const withoutCreatedAt = (queryText: string): string =>
    queryText.replace(/^\s*createdAt\s*$/m, "");
  const runListQuery = async (queryText: string): Promise<ListPayload> => {
    const queryWithoutCreatedAt = withoutCreatedAt(queryText);
    const shouldIncludeCreatedAt = metaobjectCreatedAtFieldSupported !== false;
    const initialQuery = shouldIncludeCreatedAt
      ? queryText
      : queryWithoutCreatedAt;
    const payload = await executeListQuery(initialQuery);

    if (
      shouldIncludeCreatedAt &&
      hasGraphqlError(
        payload.errors,
        METAOBJECT_CREATED_AT_FIELD_ERROR_PATTERNS
      )
    ) {
      metaobjectCreatedAtFieldSupported = false;
      return executeListQuery(queryWithoutCreatedAt);
    }

    if (
      shouldIncludeCreatedAt &&
      (!payload.errors || payload.errors.length === 0)
    ) {
      metaobjectCreatedAtFieldSupported = true;
    }
    return payload;
  };
  const toResult = (payload: ListPayload): { nodes: Array<any>; pageInfo: PageInfo } => {
    const edges = payload.data?.metaobjects?.edges || [];
    return {
      nodes: edges.map((edge) => edge.node),
      pageInfo: {
        hasNextPage: payload.data?.metaobjects?.pageInfo?.hasNextPage || false,
        endCursor: payload.data?.metaobjects?.pageInfo?.endCursor || null,
      },
    };
  };
  const throwGraphqlErrors = (errors: Array<{ message: string }>) => {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `GraphQL errors: ${errors.map((e) => e.message).join(", ")}`
    );
  };

  const combinedPayload = await runListQuery(LIST_QUERY_WITH_STATUS_AND_CAPABILITY);
  if (!combinedPayload.errors || combinedPayload.errors.length === 0) {
    return toResult(combinedPayload);
  }
  const combinedErrors = combinedPayload.errors;
  const isStatusUnsupported = hasGraphqlError(
    combinedErrors,
    METAOBJECT_FIELD_ERROR_PATTERNS
  );
  const isCapabilityUnsupported = hasGraphqlError(
    combinedErrors,
    METAOBJECT_CAPABILITY_FIELD_ERROR_PATTERNS
  );

  if (!isStatusUnsupported && !isCapabilityUnsupported) {
    throwGraphqlErrors(combinedErrors);
  }

  if (isStatusUnsupported && isCapabilityUnsupported) {
    const legacyPayload = await runListQuery(LEGACY_LIST_QUERY);
    if (legacyPayload.errors && legacyPayload.errors.length > 0) {
      throwGraphqlErrors(legacyPayload.errors);
    }
    return toResult(legacyPayload);
  }

  if (isStatusUnsupported) {
    const capabilityPayload = await runListQuery(LIST_QUERY_WITH_CAPABILITY);
    if (!capabilityPayload.errors || capabilityPayload.errors.length === 0) {
      return toResult(capabilityPayload);
    }
    if (
      hasGraphqlError(
        capabilityPayload.errors,
        METAOBJECT_CAPABILITY_FIELD_ERROR_PATTERNS
      )
    ) {
      const legacyPayload = await runListQuery(LEGACY_LIST_QUERY);
      if (legacyPayload.errors && legacyPayload.errors.length > 0) {
        throwGraphqlErrors(legacyPayload.errors);
      }
      return toResult(legacyPayload);
    }
    throwGraphqlErrors(capabilityPayload.errors);
  }

  const statusPayload = await runListQuery(LIST_QUERY_WITH_STATUS);
  if (!statusPayload.errors || statusPayload.errors.length === 0) {
    return toResult(statusPayload);
  }
  if (hasGraphqlError(statusPayload.errors, METAOBJECT_FIELD_ERROR_PATTERNS)) {
    const legacyPayload = await runListQuery(LEGACY_LIST_QUERY);
    if (legacyPayload.errors && legacyPayload.errors.length > 0) {
      throwGraphqlErrors(legacyPayload.errors);
    }
    return toResult(legacyPayload);
  }
  throwGraphqlErrors(statusPayload.errors);
}

async function fetchMetaobjectsWithFallback(params: {
  admin: AdminApiContext;
  query?: string;
  first: number;
  after?: string | null;
  fallbackFirst?: number;
  fallbackOnEmpty?: boolean;
  fallbackMax?: number;
  allowTruncated?: boolean;
  correlationId?: string;
  shop?: string;
  queryName?: string;
}): Promise<{ nodes: Array<any>; pageInfo: PageInfo; usedFallback: boolean }> {
  const fallbackLimit = Math.min(
    params.fallbackFirst ?? params.first,
    params.fallbackMax ?? FALLBACK_MAX
  );
  try {
    const primary = await fetchMetaobjects({
      admin: params.admin,
      query: params.query,
      first: params.first,
      after: params.after ?? null,
    });

    if (
      params.query &&
      params.fallbackOnEmpty &&
      primary.nodes.length === 0
    ) {
      logEvent(
        "review.query.filter_failed",
        {
          reason: "empty_result",
          queryName: params.queryName || "unknown",
          queryLength: params.query?.length || 0,
          fallbackLimit,
        },
        {
          correlationId: params.correlationId,
          shop: params.shop,
          severity: "warn",
        }
      );
      const fallback = await fetchMetaobjects({
        admin: params.admin,
        first: fallbackLimit,
        after: null,
      });
      if (fallback.pageInfo.hasNextPage) {
        logEvent(
          "review.query.fallback_truncated",
          {
            queryName: params.queryName || "unknown",
            fallbackLimit,
          },
          {
            correlationId: params.correlationId,
            shop: params.shop,
            severity: "warn",
          }
        );
        if (!params.allowTruncated) {
          throw new ReviewServiceError(
            ErrorCode.REVIEW_QUERY_FAILED,
            "Fallback metaobject query reached limit.",
            { fallbackLimit }
          );
        }
      }
      return { ...fallback, usedFallback: true };
    }

    return { ...primary, usedFallback: false };
  } catch (error) {
    if (!params.query) {
      throw error;
    }

    logEvent(
      "review.query.filter_failed",
      {
        reason: "query_error",
        queryName: params.queryName || "unknown",
        queryLength: params.query?.length || 0,
        fallbackLimit,
      },
      {
        correlationId: params.correlationId,
        shop: params.shop,
        severity: "warn",
      }
    );
    const fallback = await fetchMetaobjects({
      admin: params.admin,
      first: fallbackLimit,
      after: null,
    });
    if (fallback.pageInfo.hasNextPage) {
      logEvent(
        "review.query.fallback_truncated",
        {
          queryName: params.queryName || "unknown",
          fallbackLimit,
        },
        {
          correlationId: params.correlationId,
          shop: params.shop,
          severity: "warn",
        }
      );
      if (!params.allowTruncated) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_QUERY_FAILED,
          "Fallback metaobject query reached limit.",
          { fallbackLimit }
        );
      }
    }
    return { ...fallback, usedFallback: true };
  }
}

function filterReviewItems(params: {
  items: ReviewItem[];
  productId?: string;
  orderId?: string;
  includeDraft?: boolean;
  reviewType?: ReviewType | "all";
  statusFilter?: ReviewStatusFilter;
  searchQuery?: string;
  placement?: ReviewPlacement;
}): ReviewItem[] {
  const targetProduct = params.productId
    ? normalizeGid(params.productId, "Product")
    : null;
  const targetOrder = params.orderId
    ? normalizeGid(params.orderId, "Order")
    : null;
  const targetReviewType =
    params.reviewType && params.reviewType !== "all" ? params.reviewType : null;
  const targetStatus =
    params.statusFilter && params.statusFilter !== "all"
      ? params.statusFilter
      : null;
  const searchToken = params.searchQuery?.trim().toLowerCase() || null;

  return params.items.filter((item) => {
    if (
      !params.includeDraft &&
      item.status !== "ACTIVE" &&
      item.status !== "UNKNOWN"
    ) {
      return false;
    }

    if (targetProduct) {
      const normalized = normalizeGid(item.productId, "Product");
      if (normalized !== targetProduct) {
        return false;
      }
    }

    if (targetOrder) {
      const rawOrderId = item.orderId || item.label.replace("customer-", "");
      const normalizedOrder = normalizeGid(rawOrderId, "Order");
      if (normalizedOrder !== targetOrder) {
        return false;
      }
    }

    if (targetReviewType && item.reviewType !== targetReviewType) {
      return false;
    }

    if (params.placement === "homepage") {
      if (
        item.reviewType !== "admin" ||
        item.source !== REVIEW_PLACEMENT.homepage
      ) {
        return false;
      }
    }

    if (
      params.placement === "product" &&
      item.source === REVIEW_PLACEMENT.homepage
    ) {
      return false;
    }

    if (targetStatus && item.status !== targetStatus) {
      return false;
    }

    if (searchToken) {
      const haystack = [
        item.label,
        item.body,
        item.authorDisplayName || "",
        item.productId,
        item.orderId || "",
        item.reviewType,
        item.status,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchToken)) {
        return false;
      }
    }

    return item.reviewType === "customer" || item.reviewType === "admin";
  });
}

type ReviewAuthorAddress = {
  firstName?: string | null;
  lastName?: string | null;
  country?: string | null;
  countryCodeV2?: string | null;
} | null;

type ReviewAuthorCustomer = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  defaultAddress?: ReviewAuthorAddress;
};

type ReviewAuthorOrder = {
  id: string;
  shippingAddress?: ReviewAuthorAddress;
  billingAddress?: ReviewAuthorAddress;
  customer?: ReviewAuthorCustomer | null;
};

type ReviewAuthorNode =
  | ({ __typename: "Order" } & ReviewAuthorOrder)
  | ({ __typename: "Customer" } & ReviewAuthorCustomer);

function normalizeReferenceGid(
  value: string | null | undefined,
  type: "Order" | "Customer"
): string | null {
  if (!value) return null;
  const normalized = normalizeGid(value, type);
  const expectedPrefix = `gid://shopify/${type}/`;
  return normalized.startsWith(expectedPrefix) ? normalized : null;
}

function firstSafeIdentityValue(
  values: Array<string | null | undefined>,
  internalIds: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const safeValue = sanitizePublicIdentityValue(value, internalIds);
    if (safeValue) return safeValue;
  }
  return null;
}

function addressCountry(
  address: ReviewAuthorAddress,
  internalIds: Array<string | null | undefined>
): string | null {
  if (!address) return null;
  return firstSafeIdentityValue(
    [address.country, address.countryCodeV2],
    internalIds
  );
}

async function enrichReviewAuthors(params: {
  admin: AdminApiContext;
  items: ReviewItem[];
  shop: string;
  correlationId?: string;
}): Promise<ReviewItem[]> {
  const referenceIds = Array.from(
    new Set(
      params.items
        .filter((item) => item.reviewType === "customer")
        .flatMap((item) => [
          normalizeReferenceGid(item.orderId, "Order"),
          normalizeReferenceGid(item.customerId, "Customer"),
        ])
        .filter((id): id is string => Boolean(id))
    )
  );

  let nodesById = new Map<string, ReviewAuthorNode>();

  if (referenceIds.length > 0) {
    const REVIEW_AUTHOR_QUERY = `
      query getReviewAuthors($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Order {
            id
            shippingAddress {
              firstName
              lastName
              country
              countryCodeV2
            }
            billingAddress {
              firstName
              lastName
              country
              countryCodeV2
            }
            customer {
              id
              firstName
              lastName
              defaultAddress {
                country
                countryCodeV2
              }
            }
          }
          ... on Customer {
            id
            firstName
            lastName
            defaultAddress {
              country
              countryCodeV2
            }
          }
        }
      }
    `;

    try {
      const response = await params.admin.graphql(REVIEW_AUTHOR_QUERY, {
        variables: { ids: referenceIds },
      });
      if (!response.ok) {
        throw new Error(`Shopify Admin API request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as {
        data?: { nodes?: Array<ReviewAuthorNode | null> };
        errors?: Array<{ message: string }>;
      };
      if (payload.errors && payload.errors.length > 0) {
        throw new Error(
          `GraphQL errors: ${payload.errors.map((error) => error.message).join(", ")}`
        );
      }

      nodesById = new Map(
        (payload.data?.nodes || [])
          .filter(
            (node): node is ReviewAuthorNode & { id: string } =>
              Boolean(node && node.id)
          )
          .map((node) => [node.id, node])
      );
    } catch (error) {
      logEvent(
        "review.list.author_enrichment.fail",
        {
          referenceCount: referenceIds.length,
          reason: error instanceof Error ? error.message : String(error),
        },
        {
          correlationId: params.correlationId,
          shop: params.shop,
          severity: "warn",
        }
      );
      nodesById = new Map();
    }
  }

  return params.items.map((item) => {
    const internalIds = [item.orderId, item.customerId];
    const existingFirstName = sanitizePublicIdentityValue(
      item.firstName,
      internalIds
    );
    const existingLastName = sanitizePublicIdentityValue(
      item.lastName,
      internalIds
    );
    const existingCountry = sanitizePublicIdentityValue(
      item.country,
      internalIds
    );
    const existingAuthorDisplayName = sanitizePublicIdentityValue(
      item.authorDisplayName,
      internalIds
    );

    if (item.reviewType !== "customer") {
      return {
        ...item,
        firstName: existingFirstName,
        lastName: existingLastName,
        country: existingCountry,
        authorDisplayName: existingAuthorDisplayName,
      };
    }

    const orderGid = normalizeReferenceGid(item.orderId, "Order");
    const customerGid = normalizeReferenceGid(item.customerId, "Customer");
    const orderCandidate = orderGid ? nodesById.get(orderGid) : null;
    const order =
      orderCandidate?.__typename === "Order" ? orderCandidate : null;
    const customerCandidate = customerGid ? nodesById.get(customerGid) : null;
    const referencedCustomer =
      customerCandidate?.__typename === "Customer" ? customerCandidate : null;
    const customer = order?.customer || referencedCustomer;

    const firstName = firstSafeIdentityValue(
      [
        customer?.firstName,
        order?.shippingAddress?.firstName,
        order?.billingAddress?.firstName,
        existingFirstName,
      ],
      internalIds
    );
    const lastName = firstSafeIdentityValue(
      [
        customer?.lastName,
        order?.shippingAddress?.lastName,
        order?.billingAddress?.lastName,
        existingLastName,
      ],
      internalIds
    );
    const country =
      addressCountry(order?.shippingAddress || null, internalIds) ||
      addressCountry(order?.billingAddress || null, internalIds) ||
      addressCountry(customer?.defaultAddress || null, internalIds) ||
      existingCountry;

    return {
      ...item,
      firstName,
      lastName,
      country,
      authorDisplayName:
        existingAuthorDisplayName ||
        buildPublicAuthorDisplayName(firstName, lastName),
    };
  });
}

const NEWEST_CURSOR_PREFIX = "newest:";

type NewestCursorState = {
  after: string | null;
  offset: number;
};

function parseNewestCursor(cursor: string | null | undefined): NewestCursorState {
  if (!cursor) {
    return { after: null, offset: 0 };
  }

  if (!cursor.startsWith(NEWEST_CURSOR_PREFIX)) {
    // Accept cursors issued before server-side newest sorting was introduced.
    return { after: cursor, offset: 0 };
  }

  try {
    const encoded = cursor.slice(NEWEST_CURSOR_PREFIX.length);
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<NewestCursorState>;
    const afterIsValid = parsed.after === null || typeof parsed.after === "string";
    const offsetIsValid =
      Number.isInteger(parsed.offset) && Number(parsed.offset) >= 0;

    if (!afterIsValid || !offsetIsValid) {
      throw new Error("invalid cursor payload");
    }

    return {
      after: parsed.after ?? null,
      offset: Number(parsed.offset),
    };
  } catch {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_INVALID_INPUT,
      "유효하지 않은 리뷰 목록 cursor입니다."
    );
  }
}

function encodeNewestCursor(state: NewestCursorState): string {
  return `${NEWEST_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify(state),
    "utf8"
  ).toString("base64url")}`;
}

function parseReviewTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sortReviewsNewest(items: ReviewItem[]): ReviewItem[] {
  return items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .sort((left, right) => {
      const leftTimestamp =
        parseReviewTimestamp(left.item.submittedAt) ??
        parseReviewTimestamp(left.item.createdAt);
      const rightTimestamp =
        parseReviewTimestamp(right.item.submittedAt) ??
        parseReviewTimestamp(right.item.createdAt);

      if (leftTimestamp !== null && rightTimestamp !== null) {
        const timestampDifference = rightTimestamp - leftTimestamp;
        if (timestampDifference !== 0) return timestampDifference;
      } else if (leftTimestamp !== null) {
        return -1;
      } else if (rightTimestamp !== null) {
        return 1;
      }

      // Keep Shopify's source order as a deterministic fallback when dates tie
      // or both dates are absent/invalid.
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ item }) => item);
}

export async function listReviewsByProduct(params: {
  shop: string;
  productId?: string;
  limit?: number;
  cursor?: string | null;
  includeDraft?: boolean;
  reviewType?: ReviewType | "all";
  placement?: ReviewPlacement;
  sort?: "newest";
  correlationId?: string;
}): Promise<{ items: ReviewItem[]; pageInfo: PageInfo }> {
  const admin = await resolveAdmin(params.shop);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const cursorState = parseNewestCursor(params.cursor);
  const productGid = params.productId
    ? normalizeGid(params.productId, "Product")
    : null;
  const reviewTypeQuery =
    params.reviewType && params.reviewType !== "all"
      ? `review_type:${params.reviewType}`
      : "(review_type:customer OR review_type:admin)";
  const query = productGid
    ? `product:"${escapeQueryValue(
        productGid
      )}" AND ${reviewTypeQuery}`
    : reviewTypeQuery;

  const collected: ReviewItem[] = [];
  let cursor = cursorState.after;
  let lastPageInfo: PageInfo = {
    hasNextPage: false,
    endCursor: null,
  };
  let usedFallback = false;
  const maxPages = 10;
  const scanPageSize = 50;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchMetaobjectsWithFallback({
      admin,
      query,
      first: scanPageSize,
      after: cursor,
      fallbackFirst: Math.max(100, limit),
      fallbackOnEmpty: true,
      correlationId: params.correlationId,
      shop: params.shop,
      queryName: "listReviewsByProduct",
    });
    usedFallback = usedFallback || page.usedFallback;
    lastPageInfo = page.pageInfo;

    const parsed = page.nodes
      .map((node) => parseReviewItem(node))
      .filter((item): item is ReviewItem => item !== null);

    const filtered = filterReviewItems({
      items: parsed,
      productId: productGid || undefined,
      includeDraft: params.includeDraft,
      reviewType: params.reviewType,
      placement: params.placement,
    });

    collected.push(...filtered);

    if (page.usedFallback) {
      break;
    }

    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) {
      break;
    }
    cursor = page.pageInfo.endCursor;
  }

  const scanTruncated =
    !usedFallback &&
    lastPageInfo.hasNextPage &&
    Boolean(lastPageInfo.endCursor);
  if (scanTruncated) {
    logEvent(
      "review.list.newest_scan_truncated",
      {
        maxPages,
        scanPageSize,
        scannedReviewCount: collected.length,
      },
      {
        correlationId: params.correlationId,
        shop: params.shop,
        severity: "warn",
      }
    );
  }

  const sorted = sortReviewsNewest(collected);
  const pageItems = sorted.slice(cursorState.offset, cursorState.offset + limit);
  const nextOffset = cursorState.offset + pageItems.length;
  const hasNextInScannedWindow = nextOffset < sorted.length;
  const hasNextPage = hasNextInScannedWindow || scanTruncated;
  const endCursor = hasNextInScannedWindow
    ? encodeNewestCursor({ after: cursorState.after, offset: nextOffset })
    : scanTruncated && lastPageInfo.endCursor
      ? encodeNewestCursor({ after: lastPageInfo.endCursor, offset: 0 })
      : null;

  const items = await enrichReviewAuthors({
    admin,
    items: pageItems,
    shop: params.shop,
    correlationId: params.correlationId,
  });

  return {
    items,
    pageInfo: {
      hasNextPage,
      endCursor,
    },
  };
}

export async function listAdminReviews(params: {
  shop: string;
  limit?: number;
  cursor?: string | null;
  includeDraft?: boolean;
  correlationId?: string;
}): Promise<{ items: ReviewItem[]; pageInfo: PageInfo }> {
  const admin = await resolveAdmin(params.shop);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const query = `review_type:admin${
    params.includeDraft ? "" : " AND status:active"
  }`;

  const { nodes, pageInfo, usedFallback } = await fetchMetaobjectsWithFallback({
    admin,
    query,
    first: limit,
    after: params.cursor ?? null,
    fallbackFirst: Math.max(100, limit),
    fallbackOnEmpty: true,
    fallbackMax: 500,
    allowTruncated: true,
    correlationId: params.correlationId,
    shop: params.shop,
    queryName: "listAdminReviews",
  });

  const parsed = nodes
    .map((node) => parseReviewItem(node))
    .filter((item): item is ReviewItem => item !== null);

  const filtered = filterReviewItems({
    items: parsed,
    includeDraft: params.includeDraft,
  }).filter((item) => item.reviewType === "admin");

  // Shopify's metaobject connection order is not reliable across API versions.
  // The Reviews admin must always show the most recently submitted review first.
  const items = sortReviewsNewest(filtered).slice(0, limit);

  return {
    items,
    pageInfo: usedFallback
      ? {
          hasNextPage: filtered.length > limit,
          endCursor: null,
        }
      : pageInfo,
  };
}

export async function listAllReviews(params: {
  shop: string;
  limit?: number;
  cursor?: string | null;
  includeDraft?: boolean;
  reviewType?: ReviewType | "all";
  statusFilter?: ReviewStatusFilter;
  searchQuery?: string;
  correlationId?: string;
}): Promise<{ items: ReviewItem[]; pageInfo: PageInfo }> {
  const admin = await resolveAdmin(params.shop);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
  const reviewTypeQuery =
    params.reviewType && params.reviewType !== "all"
      ? `review_type:${params.reviewType}`
      : "(review_type:admin OR review_type:customer)";
  const statusQuery =
    params.statusFilter === "ACTIVE"
      ? " AND status:active"
      : params.statusFilter === "DRAFT"
      ? " AND status:draft"
      : params.statusFilter === "UNKNOWN"
      ? ""
      : params.includeDraft
      ? ""
      : " AND status:active";
  const query = `${reviewTypeQuery}${statusQuery}`;

  const { nodes, pageInfo, usedFallback } = await fetchMetaobjectsWithFallback({
    admin,
    query,
    first: limit,
    after: params.cursor ?? null,
    fallbackFirst: Math.max(100, limit),
    fallbackOnEmpty: true,
    fallbackMax: 500,
    allowTruncated: true,
    correlationId: params.correlationId,
    shop: params.shop,
    queryName: "listAllReviews",
  });

  const parsed = nodes
    .map((node) => parseReviewItem(node))
    .filter((item): item is ReviewItem => item !== null);

  const filtered = filterReviewItems({
    items: parsed,
    includeDraft: params.includeDraft,
    reviewType: params.reviewType,
    statusFilter: params.statusFilter,
    searchQuery: params.searchQuery,
  });

  // The Admin API does not guarantee a chronological metaobject connection.
  // Sort after local filtering so the admin screen is consistently newest first.
  const items = sortReviewsNewest(filtered).slice(0, limit);

  return {
    items,
    pageInfo: usedFallback
      ? {
          hasNextPage: filtered.length > limit,
          endCursor: null,
        }
      : pageInfo,
  };
}

export async function findCustomerReviewByOrder(params: {
  shop: string;
  orderId: string;
  correlationId?: string;
}): Promise<ReviewItem | null> {
  const admin = await resolveAdmin(params.shop);
  const orderGid = normalizeGid(params.orderId, "Order");
  const query = `order:"${escapeQueryValue(orderGid)}" AND review_type:customer`;

  const { nodes } = await fetchMetaobjectsWithFallback({
    admin,
    query,
    first: 50,
    fallbackFirst: 200,
    fallbackOnEmpty: true,
    correlationId: params.correlationId,
    shop: params.shop,
    queryName: "findCustomerReviewByOrder",
  });

  const parsed = nodes
    .map((node) => parseReviewItem(node))
    .filter((item): item is ReviewItem => item !== null);

  const filtered = filterReviewItems({
    items: parsed,
    orderId: orderGid,
    includeDraft: true,
  }).filter((item) => item.reviewType === "customer");

  return filtered[0] || null;
}

export async function listCustomerReviewStatusByOrders(params: {
  shop: string;
  customerId: string;
  orderIds: string[];
  correlationId?: string;
}): Promise<{ items: CustomerOrderReviewStatusItem[] }> {
  const admin = await resolveAdmin(params.shop);
  const customerGid = normalizeGid(params.customerId, "Customer");
  const normalizedOrderIds = Array.from(
    new Set(
      params.orderIds
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => normalizeGid(value, "Order"))
    )
  );

  if (normalizedOrderIds.length === 0) {
    return { items: [] };
  }

  const targetOrderSet = new Set(normalizedOrderIds);

  const resolveOrderGid = (item: ReviewItem): string | null => {
    const rawOrderId =
      item.orderId ||
      (item.label.startsWith("customer-")
        ? item.label.slice("customer-".length)
        : "");
    if (!rawOrderId) return null;
    return normalizeGid(rawOrderId, "Order");
  };

  const collectMatches = async (
    query: string,
    forceCustomerFilter: boolean
  ): Promise<Map<string, ReviewItem>> => {
    const matches = new Map<string, ReviewItem>();
    let cursor: string | null = null;
    let page = 0;
    const PAGE_SIZE = 50;
    const MAX_PAGES = 20;

    while (page < MAX_PAGES && matches.size < targetOrderSet.size) {
      const { nodes, pageInfo } = await fetchMetaobjects({
        admin,
        query,
        first: PAGE_SIZE,
        after: cursor,
      });
      const parsed = nodes
        .map((node) => parseReviewItem(node))
        .filter((item): item is ReviewItem => item !== null);

      for (const item of parsed) {
        if (item.reviewType !== "customer") continue;
        if (forceCustomerFilter) {
          const normalizedCustomerId = item.customerId
            ? normalizeGid(item.customerId, "Customer")
            : null;
          if (normalizedCustomerId !== customerGid) continue;
        }
        const orderGid = resolveOrderGid(item);
        if (!orderGid || !targetOrderSet.has(orderGid)) continue;
        if (!matches.has(orderGid)) {
          matches.set(orderGid, item);
        }
      }

      if (!pageInfo.hasNextPage || !pageInfo.endCursor) {
        break;
      }
      cursor = pageInfo.endCursor;
      page += 1;
    }

    return matches;
  };

  const customerQuery = `review_type:customer AND customer:"${escapeQueryValue(
    customerGid
  )}"`;
  let matches = new Map<string, ReviewItem>();

  try {
    matches = await collectMatches(customerQuery, false);
  } catch (error) {
    logEvent(
      "review.order_status.query_fallback",
      {
        reason: error instanceof Error ? error.message : String(error),
        orderCount: normalizedOrderIds.length,
      },
      {
        correlationId: params.correlationId,
        shop: params.shop,
        severity: "warn",
      }
    );
  }

  if (matches.size < targetOrderSet.size) {
    const fallbackMatches = await collectMatches("review_type:customer", true);
    for (const [orderId, item] of fallbackMatches.entries()) {
      if (!matches.has(orderId)) {
        matches.set(orderId, item);
      }
    }
  }

  const items = normalizedOrderIds.map((orderId) => {
    const review = matches.get(orderId);
    return {
      orderId,
      reviewed: Boolean(review),
      canEdit: Boolean(review),
      review: review
        ? {
            id: review.id,
            productId: review.productId,
            reviewType: review.reviewType,
            body: review.body,
            label: review.label,
            authorDisplayName: review.authorDisplayName ?? null,
            submittedAt: review.submittedAt,
            status: review.status,
          }
        : null,
    };
  });

  return { items };
}

export async function createCustomerReviewMetaobject(params: {
  shop: string;
  productId: string;
  orderId: string;
  body: string;
  customerId?: string;
  authorDisplayName?: string;
}): Promise<ReviewItem> {
  const admin = await resolveAdmin(params.shop);
  const orderGid = normalizeGid(params.orderId, "Order");
  const productGid = normalizeGid(params.productId, "Product");
  const label = buildCustomerLabel(params.orderId);

  const fields: Array<{ key: string; value: string }> = [
    { key: FIELD_KEYS.product, value: productGid },
    { key: FIELD_KEYS.reviewType, value: "customer" },
    { key: FIELD_KEYS.body, value: params.body },
    { key: FIELD_KEYS.label, value: label },
    { key: FIELD_KEYS.order, value: orderGid },
    { key: FIELD_KEYS.source, value: "bta-proxy" },
  ];

  if (params.customerId) {
    fields.push({
      key: FIELD_KEYS.customer,
      value: normalizeGid(params.customerId, "Customer"),
    });
  }
  if (params.authorDisplayName) {
    fields.push({
      key: FIELD_KEYS.authorDisplayName,
      value: params.authorDisplayName,
    });
  }

  fields.push({
    key: FIELD_KEYS.submittedAt,
    value: new Date().toISOString(),
  });

  const CREATE_MUTATION = `
    mutation createReview($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject {
          id
          status
          createdAt
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;
  const LEGACY_CREATE_MUTATION = `
    mutation createReview($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject {
          id
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(CREATE_MUTATION, {
    variables: {
      metaobject: {
        type: REVIEW_METAOBJECT_TYPE,
        fields,
      },
    },
  });

  if (!response.ok) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `Shopify Admin API request failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id: string; status?: string; createdAt?: string; fields: Array<{ key: string; value: string }> };
        userErrors?: Array<{ message: string }>
      }
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    const shouldFallbackSelection =
      hasGraphqlError(payload.errors, METAOBJECT_FIELD_ERROR_PATTERNS) ||
      hasGraphqlError(payload.errors, METAOBJECT_CREATED_AT_FIELD_ERROR_PATTERNS);
    const shouldOmitStatus =
      hasMetaobjectStatusInputError(payload.errors, "create") ||
      hasGraphqlError(payload.errors, METAOBJECT_INPUT_ERROR_PATTERNS);
    if (shouldFallbackSelection || shouldOmitStatus) {
      const legacyResponse = await admin.graphql(LEGACY_CREATE_MUTATION, {
        variables: {
          metaobject: {
            type: REVIEW_METAOBJECT_TYPE,
            fields,
          },
        },
      });
      if (!legacyResponse.ok) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          `Shopify Admin API request failed with status ${legacyResponse.status}`
        );
      }
      const legacyPayload = (await legacyResponse.json()) as {
        data?: {
          metaobjectCreate?: {
            metaobject?: {
              id: string;
              status?: string;
              createdAt?: string;
              fields: Array<{ key: string; value: string }>;
            };
            userErrors?: Array<{ message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      };
      if (legacyPayload.errors && legacyPayload.errors.length > 0) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          `GraphQL errors: ${legacyPayload.errors
            .map((e) => e.message)
            .join(", ")}`
        );
      }
      const legacyUserErrors = legacyPayload.data?.metaobjectCreate?.userErrors || [];
      if (legacyUserErrors.length > 0) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          legacyUserErrors.map((e) => e.message).join(", ")
        );
      }
      const legacyNode = legacyPayload.data?.metaobjectCreate?.metaobject;
      if (!legacyNode) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          "Metaobject creation failed"
        );
      }
      const legacyParsed = parseReviewItem(legacyNode);
      if (!legacyParsed) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          "Metaobject parsing failed"
        );
      }
      return setReviewVisibility({
        shop: params.shop,
        reviewId: legacyParsed.id,
        visible: true,
      });
    }
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`
    );
  }

  const userErrors = payload.data?.metaobjectCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      userErrors.map((e) => e.message).join(", ")
    );
  }

  const node = payload.data?.metaobjectCreate?.metaobject;
  if (!node) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      "Metaobject creation failed"
    );
  }

  const parsed = parseReviewItem(node);
  if (!parsed) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      "Metaobject parsing failed"
    );
  }

  let finalItem = parsed;
  try {
    finalItem = await setReviewVisibility({
      shop: params.shop,
      reviewId: parsed.id,
      // Customer reviews are shown on the purchased product's public page.
      // The storefront list excludes DRAFT metaobjects, so creating these as
      // hidden made a successful My Page submission appear to disappear.
      visible: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isStatusInputUnsupportedMessage(message)) {
      throw error;
    }
  }

  return finalItem;
}

export async function createAdminReviewMetaobject(params: {
  shop: string;
  productId: string;
  body: string;
  label: string;
  authorDisplayName?: string;
  placement?: ReviewPlacement;
}): Promise<ReviewItem> {
  const admin = await resolveAdmin(params.shop);
  const productGid = normalizeGid(params.productId, "Product");

  const fields: Array<{ key: string; value: string }> = [
    { key: FIELD_KEYS.product, value: productGid },
    { key: FIELD_KEYS.reviewType, value: "admin" },
    { key: FIELD_KEYS.body, value: params.body },
    { key: FIELD_KEYS.label, value: params.label },
    {
      key: FIELD_KEYS.source,
      value: REVIEW_PLACEMENT[params.placement || "product"],
    },
    { key: FIELD_KEYS.submittedAt, value: new Date().toISOString() },
  ];

  if (params.authorDisplayName) {
    fields.push({
      key: FIELD_KEYS.authorDisplayName,
      value: params.authorDisplayName,
    });
  }

  const CREATE_MUTATION = `
    mutation createReview($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject {
          id
          status
          createdAt
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;
  const LEGACY_CREATE_MUTATION = `
    mutation createReview($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject {
          id
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(CREATE_MUTATION, {
    variables: {
      metaobject: {
        type: REVIEW_METAOBJECT_TYPE,
        fields,
      },
    },
  });

  if (!response.ok) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `Shopify Admin API request failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id: string; status?: string; createdAt?: string; fields: Array<{ key: string; value: string }> };
        userErrors?: Array<{ message: string }>
      }
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    const shouldFallbackSelection = hasGraphqlError(
      payload.errors,
      METAOBJECT_FIELD_ERROR_PATTERNS
    );
    const shouldOmitStatus =
      hasMetaobjectStatusInputError(payload.errors, "create") ||
      hasGraphqlError(payload.errors, METAOBJECT_INPUT_ERROR_PATTERNS);
    if (shouldFallbackSelection || shouldOmitStatus) {
      const legacyResponse = await admin.graphql(LEGACY_CREATE_MUTATION, {
        variables: {
          metaobject: {
            type: REVIEW_METAOBJECT_TYPE,
            fields,
          },
        },
      });
      if (!legacyResponse.ok) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          `Shopify Admin API request failed with status ${legacyResponse.status}`
        );
      }
      const legacyPayload = (await legacyResponse.json()) as {
        data?: {
          metaobjectCreate?: {
            metaobject?: {
              id: string;
              status?: string;
              createdAt?: string;
              fields: Array<{ key: string; value: string }>;
            };
            userErrors?: Array<{ message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      };
      if (legacyPayload.errors && legacyPayload.errors.length > 0) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          `GraphQL errors: ${legacyPayload.errors
            .map((e) => e.message)
            .join(", ")}`
        );
      }
      const legacyUserErrors = legacyPayload.data?.metaobjectCreate?.userErrors || [];
      if (legacyUserErrors.length > 0) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          legacyUserErrors.map((e) => e.message).join(", ")
        );
      }
      const legacyNode = legacyPayload.data?.metaobjectCreate?.metaobject;
      if (!legacyNode) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          "Metaobject creation failed"
        );
      }
      const legacyParsed = parseReviewItem(legacyNode);
      if (!legacyParsed) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          "Metaobject parsing failed"
        );
      }
      return legacyParsed;
    }
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`
    );
  }

  const userErrors = payload.data?.metaobjectCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      userErrors.map((e) => e.message).join(", ")
    );
  }

  const node = payload.data?.metaobjectCreate?.metaobject;
  if (!node) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      "Metaobject creation failed"
    );
  }

  const parsed = parseReviewItem(node);
  if (!parsed) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      "Metaobject parsing failed"
    );
  }

  let finalItem = parsed;
  try {
    finalItem = await setReviewVisibility({
      shop: params.shop,
      reviewId: parsed.id,
      visible: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isStatusInputUnsupportedMessage(message)) {
      throw error;
    }
  }

  return finalItem;
}

export async function setReviewVisibility(params: {
  shop: string;
  reviewId: string;
  visible: boolean;
}): Promise<ReviewItem> {
  const admin = await resolveAdmin(params.shop);
  const status = params.visible ? "ACTIVE" : "DRAFT";

  const parseUpdateResponse = (payload: {
    data?: {
      metaobjectUpdate?: {
        metaobject?: {
          id: string;
          status?: string;
          createdAt?: string;
          capabilities?: { publishable?: { status?: string } | null } | null;
          fields: Array<{ key: string; value: string }>;
        };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  }): ReviewItem => {
    const userErrors = payload.data?.metaobjectUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        userErrors.map((e) => e.message).join(", "),
        { userErrors }
      );
    }

    const node = payload.data?.metaobjectUpdate?.metaobject;
    if (!node) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_NOT_FOUND,
        "Metaobject not found"
      );
    }

    const parsed = parseReviewItem(node);
    if (!parsed) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        "Metaobject parsing failed"
      );
    }

    if (parsed.status === "UNKNOWN") {
      return {
        ...parsed,
        status,
      };
    }
    return parsed;
  };

  const runUpdateMutation = async (
    mutation: string,
    legacyMutation: string,
    metaobjectInput: Record<string, unknown>
  ): Promise<ReviewItem> => {
    const response = await admin.graphql(mutation, {
      variables: {
        id: params.reviewId,
        metaobject: metaobjectInput,
      },
    });

    if (!response.ok) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        `Shopify Admin API request failed with status ${response.status}`
      );
    }

    const payload = (await response.json()) as {
      data?: {
        metaobjectUpdate?: {
          metaobject?: {
            id: string;
            status?: string;
            createdAt?: string;
            capabilities?: { publishable?: { status?: string } | null } | null;
            fields: Array<{ key: string; value: string }>;
          };
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      const shouldFallbackSelection =
        hasGraphqlError(payload.errors, METAOBJECT_FIELD_ERROR_PATTERNS) ||
        hasGraphqlError(payload.errors, METAOBJECT_CAPABILITY_FIELD_ERROR_PATTERNS) ||
        hasGraphqlError(payload.errors, METAOBJECT_CREATED_AT_FIELD_ERROR_PATTERNS);

      if (!shouldFallbackSelection) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`,
          { graphqlErrors: payload.errors.map((e) => e.message) }
        );
      }

      const legacyResponse = await admin.graphql(legacyMutation, {
        variables: {
          id: params.reviewId,
          metaobject: metaobjectInput,
        },
      });
      if (!legacyResponse.ok) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          `Shopify Admin API request failed with status ${legacyResponse.status}`
        );
      }

      const legacyPayload = (await legacyResponse.json()) as {
        data?: {
          metaobjectUpdate?: {
            metaobject?: {
              id: string;
              fields: Array<{ key: string; value: string }>;
            };
            userErrors?: Array<{ message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      };
      if (legacyPayload.errors && legacyPayload.errors.length > 0) {
        throw new ReviewServiceError(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          `GraphQL errors: ${legacyPayload.errors
            .map((e) => e.message)
            .join(", ")}`,
          { graphqlErrors: legacyPayload.errors.map((e) => e.message) }
        );
      }
      return parseUpdateResponse(legacyPayload);
    }

    return parseUpdateResponse(payload);
  };

  const UPDATE_MUTATION_WITH_CAPABILITY = `
    mutation updateReviewVisibility($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          status
          createdAt
          capabilities {
            publishable {
              status
            }
          }
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;
  const LEGACY_UPDATE_MUTATION_WITH_CAPABILITY = `
    mutation updateReviewVisibility($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;

  const UPDATE_MUTATION_WITH_STATUS_INPUT = `
    mutation updateReviewVisibility($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          status
          createdAt
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;
  const LEGACY_UPDATE_MUTATION_WITH_STATUS_INPUT = `
    mutation updateReviewVisibility($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;

  try {
    return await runUpdateMutation(
      UPDATE_MUTATION_WITH_CAPABILITY,
      LEGACY_UPDATE_MUTATION_WITH_CAPABILITY,
      {
        capabilities: {
          publishable: {
            status,
          },
        },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldFallbackToStatusInput =
      hasMetaobjectCapabilityInputError([{ message }]) ||
      hasGraphqlError(
        [{ message }],
        METAOBJECT_CAPABILITY_INPUT_ERROR_PATTERNS
      ) ||
      message.toLowerCase().includes("publishable");

    if (!shouldFallbackToStatusInput) {
      throw error;
    }
  }

  try {
    return await runUpdateMutation(
      UPDATE_MUTATION_WITH_STATUS_INPUT,
      LEGACY_UPDATE_MUTATION_WITH_STATUS_INPUT,
      { status }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isStatusInputUnsupported =
      hasMetaobjectStatusInputError([{ message }], "update") ||
      hasGraphqlError([{ message }], METAOBJECT_INPUT_ERROR_PATTERNS);
    if (isStatusInputUnsupported) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        `Review visibility update is not supported by current Shopify schema: ${message}`,
        { reason: message }
      );
    }
    throw error;
  }
}

export async function updateReviewContent(params: {
  shop: string;
  reviewId: string;
  body: string;
  authorDisplayName?: string;
  currentStatus?: string;
}): Promise<ReviewItem> {
  const admin = await resolveAdmin(params.shop);
  const fields: Array<{ key: string; value: string }> = [
    { key: FIELD_KEYS.body, value: params.body },
  ];
  if (params.authorDisplayName !== undefined) {
    fields.push({
      key: FIELD_KEYS.authorDisplayName,
      value: params.authorDisplayName,
    });
  }

  const parseUpdateResponse = (payload: {
    data?: {
      metaobjectUpdate?: {
        metaobject?: {
          id: string;
          status?: string;
          capabilities?: { publishable?: { status?: string } | null } | null;
          fields: Array<{ key: string; value: string }>;
        };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  }): ReviewItem => {
    const userErrors = payload.data?.metaobjectUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        userErrors.map((e) => e.message).join(", "),
        { userErrors }
      );
    }

    const node = payload.data?.metaobjectUpdate?.metaobject;
    if (!node) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_NOT_FOUND,
        "Metaobject not found"
      );
    }

    const parsed = parseReviewItem(node);
    if (!parsed) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        "Metaobject parsing failed"
      );
    }

    if (parsed.status === "UNKNOWN" && params.currentStatus) {
      return {
        ...parsed,
        status: normalizeReviewStatus(params.currentStatus),
      };
    }
    return parsed;
  };

  type UpdatePayload = {
    data?: {
      metaobjectUpdate?: {
        metaobject?: {
          id: string;
          status?: string;
          capabilities?: { publishable?: { status?: string } | null } | null;
          fields: Array<{ key: string; value: string }>;
        };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const runUpdateMutation = async (
    mutation: string
  ): Promise<UpdatePayload> => {
    const response = await admin.graphql(mutation, {
      variables: {
        id: params.reviewId,
        metaobject: { fields },
      },
    });
    if (!response.ok) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        `Shopify Admin API request failed with status ${response.status}`
      );
    }
    return (await response.json()) as UpdatePayload;
  };
  const throwGraphqlErrors = (errors: Array<{ message: string }>) => {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `GraphQL errors: ${errors.map((e) => e.message).join(", ")}`,
      { graphqlErrors: errors.map((e) => e.message) }
    );
  };

  const UPDATE_MUTATION_WITH_STATUS_AND_CAPABILITY = `
    mutation updateReviewContent($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          status
          capabilities {
            publishable {
              status
            }
          }
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;
  const UPDATE_MUTATION_WITH_CAPABILITY = `
    mutation updateReviewContent($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          capabilities {
            publishable {
              status
            }
          }
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;
  const UPDATE_MUTATION_WITH_STATUS = `
    mutation updateReviewContent($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          status
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;
  const LEGACY_UPDATE_MUTATION = `
    mutation updateReviewContent($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;

  const combinedPayload = await runUpdateMutation(
    UPDATE_MUTATION_WITH_STATUS_AND_CAPABILITY
  );
  if (!combinedPayload.errors || combinedPayload.errors.length === 0) {
    return parseUpdateResponse(combinedPayload);
  }

  const combinedErrors = combinedPayload.errors;
  const isStatusUnsupported = hasGraphqlError(
    combinedErrors,
    METAOBJECT_FIELD_ERROR_PATTERNS
  );
  const isCapabilityUnsupported = hasGraphqlError(
    combinedErrors,
    METAOBJECT_CAPABILITY_FIELD_ERROR_PATTERNS
  );

  if (!isStatusUnsupported && !isCapabilityUnsupported) {
    throwGraphqlErrors(combinedErrors);
  }

  if (isStatusUnsupported && isCapabilityUnsupported) {
    const legacyPayload = await runUpdateMutation(LEGACY_UPDATE_MUTATION);
    if (legacyPayload.errors && legacyPayload.errors.length > 0) {
      throwGraphqlErrors(legacyPayload.errors);
    }
    return parseUpdateResponse(legacyPayload);
  }

  if (isStatusUnsupported) {
    const capabilityPayload = await runUpdateMutation(
      UPDATE_MUTATION_WITH_CAPABILITY
    );
    if (!capabilityPayload.errors || capabilityPayload.errors.length === 0) {
      return parseUpdateResponse(capabilityPayload);
    }
    if (
      hasGraphqlError(
        capabilityPayload.errors,
        METAOBJECT_CAPABILITY_FIELD_ERROR_PATTERNS
      )
    ) {
      const legacyPayload = await runUpdateMutation(LEGACY_UPDATE_MUTATION);
      if (legacyPayload.errors && legacyPayload.errors.length > 0) {
        throwGraphqlErrors(legacyPayload.errors);
      }
      return parseUpdateResponse(legacyPayload);
    }
    throwGraphqlErrors(capabilityPayload.errors);
  }

  const statusPayload = await runUpdateMutation(UPDATE_MUTATION_WITH_STATUS);
  if (!statusPayload.errors || statusPayload.errors.length === 0) {
    return parseUpdateResponse(statusPayload);
  }
  if (hasGraphqlError(statusPayload.errors, METAOBJECT_FIELD_ERROR_PATTERNS)) {
    const legacyPayload = await runUpdateMutation(LEGACY_UPDATE_MUTATION);
    if (legacyPayload.errors && legacyPayload.errors.length > 0) {
      throwGraphqlErrors(legacyPayload.errors);
    }
    return parseUpdateResponse(legacyPayload);
  }
  throwGraphqlErrors(statusPayload.errors);
}

export async function deleteReviewContent(params: {
  shop: string;
  reviewId: string;
}): Promise<{ deletedId: string }> {
  const admin = await resolveAdmin(params.shop);
  const mutation = `
    mutation deleteReviewContent($id: ID!) {
      metaobjectDelete(id: $id) {
        deletedId
        userErrors { field message code }
      }
    }
  `;
  const response = await admin.graphql(mutation, {
    variables: { id: params.reviewId },
  });
  if (!response.ok) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `Shopify Admin API request failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    data?: {
      metaobjectDelete?: {
        deletedId?: string | null;
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      `GraphQL errors: ${payload.errors.map((error) => error.message).join(", ")}`
    );
  }

  const result = payload.data?.metaobjectDelete;
  if (result?.userErrors?.length) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      result.userErrors.map((error) => error.message).join(", ")
    );
  }
  if (!result?.deletedId) {
    throw new ReviewServiceError(
      ErrorCode.REVIEW_NOT_FOUND,
      "Metaobject not found"
    );
  }
  return { deletedId: result.deletedId };
}
