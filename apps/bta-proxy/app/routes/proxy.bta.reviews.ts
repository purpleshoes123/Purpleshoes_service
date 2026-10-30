import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { respond } from "~/lib/respond";
import {
  parseQueryParams,
  reviewDeleteBodySchema,
  reviewsListQuerySchema,
  reviewCreateBodySchema,
  reviewUpdateBodySchema,
} from "~/lib/validation";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { logEvent } from "~/lib/logEvent";
import {
  buildPublicAuthorDisplayName,
  createCustomerReviewMetaobject,
  deleteReviewContent,
  findCustomerReviewByOrder,
  listReviewsByProduct,
  ReviewServiceError,
  sanitizePublicIdentityValue,
  updateReviewContent,
} from "~/domains/reviews/reviewService";
import { acquireReviewLock, releaseReviewLock } from "~/domains/reviews/reviewLock";
import { extractCustomerIdFromProxyRequest } from "~/domains/checkout/guideExtension/customerId";
import { isTourLineCompleted } from "~/domains/bookings/tourCompletion";

const REVIEW_LOCK_TTL_SECONDS = 10;

function normalizeGid(value: string, type: "Product" | "Order") {
  if (!value) {
    return value;
  }
  if (value.startsWith("gid://")) {
    return value;
  }
  if (/^\d+$/.test(value)) {
    return `gid://shopify/${type}/${value}`;
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isPaidStatus(status?: string | null): boolean {
  return (status || "").toUpperCase() === "PAID";
}

type OrderReviewInfo = {
  orderId: string;
  customerId: string | null;
  isPaid: boolean;
  hasProduct: boolean;
  lineItemsTruncated: boolean;
  isTourProduct: boolean;
  tourCompleted: boolean;
};

function normalizePropertyKey(value: string | null | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[ _\[\]]/g, "");
}

function normalizeNullableProductId(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCustomerId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value.startsWith("gid://")) {
    return value;
  }
  if (/^\d+$/.test(value)) {
    return `gid://shopify/Customer/${value}`;
  }
  return null;
}

async function fetchOrderForReview(params: {
  admin: AdminApiContext;
  orderId: string;
  productId: string;
}): Promise<OrderReviewInfo | null> {
  const orderGid = normalizeGid(params.orderId, "Order");
  const productGid = normalizeGid(params.productId, "Product");

  const ORDER_QUERY = `
    query getOrderForReview($id: ID!, $lineItemsFirst: Int!, $after: String) {
      order(id: $id) {
        id
        displayFinancialStatus
        cancelledAt
        tags
        customer {
          id
        }
        lineItems(first: $lineItemsFirst, after: $after) {
          edges {
            node {
              id
              product { id templateSuffix }
              customAttributes { key value }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;

  const maxPages = 10;
  let cursor: string | null = null;
  let hasNextPage = true;
  let pageCount = 0;
  let hasProduct = false;
  let isTourProduct = false;
  let tourCompleted = false;
  let orderInfo: {
    id: string;
    displayFinancialStatus?: string | null;
    cancelledAt?: string | null;
    customerId: string | null;
  } | null = null;

  while (hasNextPage && pageCount < maxPages) {
    const response = await params.admin.graphql(ORDER_QUERY, {
      variables: { id: orderGid, lineItemsFirst: 50, after: cursor },
    });

    if (!response.ok) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        `Shopify Admin API request failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      data?: {
        order?: {
          id: string;
          displayFinancialStatus?: string | null;
          cancelledAt?: string | null;
          tags?: string[];
          customer?: {
            id: string;
          } | null;
          lineItems?: {
            edges?: Array<{
              node: {
                id?: string;
                product?: { id?: string | null; templateSuffix?: string | null } | null;
                customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
              };
            }>;
            pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
          } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new ReviewServiceError(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`,
      );
    }

    const order = payload.data?.order || null;
    if (!order) {
      return null;
    }

    if (!orderInfo) {
      orderInfo = {
        id: order.id,
        displayFinancialStatus: order.displayFinancialStatus,
        cancelledAt: order.cancelledAt,
        customerId: order.customer?.id || null,
      };
    }

    const lineItems = order.lineItems?.edges || [];
    const matchedLine = lineItems.find(
      (edge) =>
        Boolean(edge.node.product?.id) &&
        normalizeGid(edge.node.product!.id!, "Product") === productGid,
    )?.node;
    hasProduct = Boolean(matchedLine);
    if (matchedLine) {
      const attributes = matchedLine.customAttributes || [];
      const travelDate = attributes.find((attribute) => {
        const key = normalizePropertyKey(attribute.key);
        return key === "traveldate" || key === "bookingdate" || key === "startdate";
      })?.value;
      const templateSuffix = (matchedLine.product?.templateSuffix || "").toLowerCase();
      isTourProduct =
        templateSuffix.includes("travel") ||
        Boolean(travelDate) ||
        attributes.some((attribute) => normalizePropertyKey(attribute.key).includes("traveler"));
      tourCompleted =
        !orderInfo?.cancelledAt &&
        isTourProduct &&
        isTourLineCompleted(order.tags || [], matchedLine.id);
    }
    if (hasProduct) {
      hasNextPage = false;
      break;
    }

    hasNextPage = order.lineItems?.pageInfo?.hasNextPage || false;
    cursor = order.lineItems?.pageInfo?.endCursor || null;
    pageCount += 1;
  }

  const lineItemsTruncated = hasNextPage && !hasProduct;

  return {
    orderId: orderInfo?.id || orderGid,
    customerId: orderInfo?.customerId || null,
    isPaid: !orderInfo?.cancelledAt && isPaidStatus(orderInfo?.displayFinancialStatus),
    hasProduct,
    lineItemsTruncated,
    isTourProduct,
    tourCompleted,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) {
    return verifyResponse;
  }

  const correlationId = respond.getCorrelationId(request);
  const startTime = Date.now();

  try {
    const url = new URL(request.url);
    const queryParams = parseQueryParams(url);
    const validatedInput = reviewsListQuerySchema.parse(queryParams);

    const shop = extractShopFromRequest(request);
    if (!shop) {
      logEvent(
        "review.list.fail",
        {
          path: url.pathname,
          method: "GET",
          productId: validatedInput.productId,
          reviewType: validatedInput.reviewType,
          errorCode: ErrorCode.REVIEW_INVALID_INPUT,
          reason: "missing_shop",
        },
        { correlationId, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_INVALID_INPUT,
        getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
        correlationId,
      );
    }

    const normalizedProductId = normalizeNullableProductId(validatedInput.productId);

    logEvent(
      "review.list.attempt",
      {
        path: url.pathname,
        method: "GET",
        productId: normalizedProductId,
        reviewType: validatedInput.reviewType,
        placement: validatedInput.placement || null,
        sort: validatedInput.sort,
        limit: validatedInput.limit,
        cursor: validatedInput.cursor || null,
      },
      { correlationId, shop },
    );

    const result = await listReviewsByProduct({
      shop,
      productId: normalizedProductId || undefined,
      reviewType: validatedInput.reviewType,
      placement: validatedInput.placement,
      sort: validatedInput.sort,
      limit: validatedInput.limit,
      cursor: validatedInput.cursor,
      correlationId,
    });

    const items = result.items.map((item) => {
      const internalIds = [item.orderId, item.customerId];
      const firstName = sanitizePublicIdentityValue(item.firstName, internalIds);
      const lastName = sanitizePublicIdentityValue(item.lastName, internalIds);
      const country = sanitizePublicIdentityValue(item.country, internalIds);
      const authorDisplayName =
        sanitizePublicIdentityValue(item.authorDisplayName, internalIds) ||
        buildPublicAuthorDisplayName(firstName, lastName);

      return {
        id: item.id,
        reviewType: item.reviewType,
        body: item.body,
        label: item.label,
        authorDisplayName,
        firstName,
        lastName,
        country,
        submittedAt: item.submittedAt,
      };
    });

    logEvent(
      "review.list.success",
      {
        path: url.pathname,
        method: "GET",
        productId: normalizedProductId,
        reviewType: validatedInput.reviewType,
        placement: validatedInput.placement || null,
        count: items.length,
        durationMs: Date.now() - startTime,
      },
      { correlationId, shop },
    );

    return respond.ok(
      {
        items,
        pageInfo: result.pageInfo,
      },
      { correlationId },
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      logEvent(
        "review.list.fail",
        {
          path: new URL(request.url).pathname,
          method: "GET",
          errorCode: ErrorCode.REVIEW_INVALID_INPUT,
          reason: errorMessage,
          durationMs: Date.now() - startTime,
        },
        { correlationId, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_INVALID_INPUT,
        getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
        correlationId,
      );
    }

    if (error instanceof ReviewServiceError) {
      logEvent(
        "review.list.fail",
        {
          path: new URL(request.url).pathname,
          method: "GET",
          errorCode: error.code,
          reason: error.message,
          durationMs: Date.now() - startTime,
        },
        { correlationId, severity: "error" },
      );
      return respond.fail(
        error.code,
        getErrorMessage(error.code, error.message),
        error.details,
        getErrorStatus(error.code),
        correlationId,
      );
    }

    logEvent(
      "review.list.fail",
      {
        path: new URL(request.url).pathname,
        method: "GET",
        errorCode: ErrorCode.INTERNAL_ERROR,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      },
      { correlationId, severity: "error" },
    );
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) {
    return verifyResponse;
  }

  const correlationId = respond.getCorrelationId(request);
  const startTime = Date.now();
  let lockKey: string | null = null;
  let lockAcquired = false;
  const lockValue = correlationId;

  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        logEvent(
          "review.create.customer.fail",
          {
            path: new URL(request.url).pathname,
            method: "POST",
            errorCode: ErrorCode.REVIEW_INVALID_INPUT,
            reason: "invalid_json",
            durationMs: Date.now() - startTime,
          },
          { correlationId, severity: "warn" },
        );
        return respond.fail(
          ErrorCode.REVIEW_INVALID_INPUT,
          getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, "잘못된 JSON 형식입니다."),
          undefined,
          getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
          correlationId,
        );
      }
      body = {};
    }

    const shop = extractShopFromRequest(request);
    if (!shop) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          errorCode: ErrorCode.REVIEW_INVALID_INPUT,
          reason: "missing_shop",
          durationMs: Date.now() - startTime,
        },
        { correlationId, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_INVALID_INPUT,
        getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
        correlationId,
      );
    }

    const customerId = extractCustomerIdFromProxyRequest(request);
    if (!customerId) {
      return respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
        correlationId,
      );
    }

    const requestedAction =
      body && typeof body === "object" && "action" in body
        ? (body as { action?: unknown }).action
        : undefined;

    if (requestedAction === "update" || requestedAction === "delete") {
      const validatedInput =
        requestedAction === "update"
          ? reviewUpdateBodySchema.parse(body)
          : reviewDeleteBodySchema.parse(body);
      const updateInput = requestedAction === "update" ? reviewUpdateBodySchema.parse(body) : null;
      lockKey = `lock:review:manage:${validatedInput.orderId}`;
      lockAcquired = await acquireReviewLock(lockKey, lockValue, REVIEW_LOCK_TTL_SECONDS);
      if (!lockAcquired) {
        return respond.fail(
          ErrorCode.REVIEW_CONFLICT,
          getErrorMessage(ErrorCode.REVIEW_CONFLICT),
          undefined,
          getErrorStatus(ErrorCode.REVIEW_CONFLICT),
          correlationId,
        );
      }

      const existing = await findCustomerReviewByOrder({
        shop,
        orderId: validatedInput.orderId,
        correlationId,
      });
      const isOwnedByCustomer =
        existing?.id === validatedInput.reviewId &&
        normalizeCustomerId(existing.customerId) === customerId;
      if (!isOwnedByCustomer) {
        throw new ReviewServiceError(ErrorCode.REVIEW_NOT_FOUND, "Review not found");
      }

      if (requestedAction === "delete") {
        const deleted = await deleteReviewContent({
          shop,
          reviewId: validatedInput.reviewId,
        });
        logEvent(
          "review.manage.customer.success",
          {
            path: new URL(request.url).pathname,
            method: "POST",
            action: "delete",
            reviewId: validatedInput.reviewId,
            durationMs: Date.now() - startTime,
          },
          { correlationId, shop },
        );
        return respond.ok({ deletedId: deleted.deletedId }, { correlationId });
      }

      const updated = await updateReviewContent({
        shop,
        reviewId: validatedInput.reviewId,
        body: escapeHtml(updateInput!.body),
        currentStatus: existing.status,
      });
      logEvent(
        "review.manage.customer.success",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          action: "update",
          reviewId: validatedInput.reviewId,
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop },
      );
      return respond.ok({ item: updated }, { correlationId });
    }

    const validatedInput = reviewCreateBodySchema.parse(body);

    lockKey = `lock:review:create:${validatedInput.orderId}`;
    lockAcquired = await acquireReviewLock(lockKey, lockValue, REVIEW_LOCK_TTL_SECONDS);
    if (!lockAcquired) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode: ErrorCode.REVIEW_CONFLICT,
          reason: "lock_conflict",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_CONFLICT,
        getErrorMessage(ErrorCode.REVIEW_CONFLICT),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_CONFLICT),
        correlationId,
      );
    }

    const admin = await getAdminApiClient(shop);
    if (!admin) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode: ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          reason: "missing_admin_session",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "error" },
      );
      return respond.fail(
        ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        getErrorMessage(
          ErrorCode.REVIEW_SHOPIFY_API_ERROR,
          "Shopify Admin API 세션을 찾을 수 없습니다.",
        ),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_SHOPIFY_API_ERROR),
        correlationId,
      );
    }

    logEvent(
      "review.create.customer.attempt",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        productId: validatedInput.productId,
        orderId: validatedInput.orderId,
        bodyLength: validatedInput.body.length,
      },
      { correlationId, shop },
    );

    const orderInfo = await fetchOrderForReview({
      admin,
      orderId: validatedInput.orderId,
      productId: validatedInput.productId,
    });

    if (!orderInfo || !orderInfo.customerId) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode: ErrorCode.REVIEW_NOT_ELIGIBLE,
          reason: "order_not_found_or_customer_missing",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_NOT_ELIGIBLE,
        getErrorMessage(ErrorCode.REVIEW_NOT_ELIGIBLE),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_NOT_ELIGIBLE),
        correlationId,
      );
    }

    if (normalizeCustomerId(orderInfo.customerId) !== customerId) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode: ErrorCode.REVIEW_NOT_ELIGIBLE,
          reason: "order_customer_mismatch",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_NOT_ELIGIBLE,
        getErrorMessage(ErrorCode.REVIEW_NOT_ELIGIBLE),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_NOT_ELIGIBLE),
        correlationId,
      );
    }

    if (!orderInfo.isPaid) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode: ErrorCode.REVIEW_NOT_ELIGIBLE,
          reason: "order_not_paid",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_NOT_ELIGIBLE,
        getErrorMessage(ErrorCode.REVIEW_NOT_ELIGIBLE),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_NOT_ELIGIBLE),
        correlationId,
      );
    }

    if (!orderInfo.hasProduct) {
      const errorCode = orderInfo.lineItemsTruncated
        ? ErrorCode.REVIEW_SHOPIFY_API_ERROR
        : ErrorCode.REVIEW_NOT_ELIGIBLE;
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode,
          reason: orderInfo.lineItemsTruncated ? "line_items_truncated" : "product_not_in_order",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        errorCode,
        getErrorMessage(errorCode),
        {
          ...(orderInfo.lineItemsTruncated ? { lineItemsTruncated: true } : {}),
        },
        getErrorStatus(errorCode),
        correlationId,
      );
    }

    // The storefront hides the form before the tour ends, but this server-side
    // check is the authority: a crafted request cannot create an early review.
    if (orderInfo.isTourProduct && !orderInfo.tourCompleted) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode: ErrorCode.REVIEW_NOT_ELIGIBLE,
          reason: "tour_not_completed",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_NOT_ELIGIBLE,
        "Tour reviews are available after the tour is completed.",
        undefined,
        getErrorStatus(ErrorCode.REVIEW_NOT_ELIGIBLE),
        correlationId,
      );
    }

    const existing = await findCustomerReviewByOrder({
      shop,
      orderId: validatedInput.orderId,
      correlationId,
    });

    if (existing) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          productId: validatedInput.productId,
          orderId: validatedInput.orderId,
          errorCode: ErrorCode.REVIEW_DUPLICATE,
          reason: "duplicate_review",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_DUPLICATE,
        getErrorMessage(ErrorCode.REVIEW_DUPLICATE),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_DUPLICATE),
        correlationId,
      );
    }

    const sanitizedBody = escapeHtml(validatedInput.body);

    const created = await createCustomerReviewMetaobject({
      shop,
      productId: validatedInput.productId,
      orderId: validatedInput.orderId,
      body: sanitizedBody,
      customerId: orderInfo.customerId,
    });

    const response = respond.ok(
      {
        id: created.id,
        reviewType: created.reviewType,
        body: created.body,
        label: created.label,
        authorDisplayName: created.authorDisplayName ?? null,
        submittedAt: created.submittedAt,
      },
      { correlationId },
    );

    logEvent(
      "review.create.customer.success",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        productId: validatedInput.productId,
        orderId: validatedInput.orderId,
        durationMs: Date.now() - startTime,
      },
      { correlationId, shop },
    );

    return response;
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          errorCode: ErrorCode.REVIEW_INVALID_INPUT,
          reason: errorMessage,
          durationMs: Date.now() - startTime,
        },
        { correlationId, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_INVALID_INPUT,
        getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
        correlationId,
      );
    }

    if (error instanceof ReviewServiceError) {
      logEvent(
        "review.create.customer.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          errorCode: error.code,
          reason: error.message,
          durationMs: Date.now() - startTime,
        },
        { correlationId, severity: "error" },
      );
      return respond.fail(
        error.code,
        getErrorMessage(error.code, error.message),
        error.details,
        getErrorStatus(error.code),
        correlationId,
      );
    }

    logEvent(
      "review.create.customer.fail",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        errorCode: ErrorCode.INTERNAL_ERROR,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      },
      { correlationId, severity: "error" },
    );
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  } finally {
    if (lockKey && lockAcquired) {
      await releaseReviewLock(lockKey, lockValue);
    }
  }
};
