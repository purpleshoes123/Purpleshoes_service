import type { LoaderFunctionArgs } from "react-router";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import { logEvent } from "~/lib/logEvent";
import { extractCustomerIdFromProxyRequest } from "~/domains/checkout/guideExtension/customerId";
import { reviewOrderStatusQuerySchema } from "~/lib/validation";
import {
  listCustomerReviewStatusByOrders,
  ReviewServiceError,
} from "~/domains/reviews/reviewService";

function parseOrderIdsFromQuery(url: URL): string[] {
  const repeated = url.searchParams.getAll("orderId");
  const csv = (url.searchParams.get("orderIds") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return [...repeated, ...csv].map((value) => value.trim()).filter(Boolean);
}

/**
 * GET /proxy/bta/reviews/order-status
 * 로그인 고객의 주문 ID 목록에 대해 리뷰 작성 여부/리뷰 요약을 반환합니다.
 */
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
  const url = new URL(request.url);
  const pathname = url.pathname;

  try {
    const shop = extractShopFromRequest(request);
    if (!shop) {
      logEvent(
        "review.order_status.list.fail",
        {
          path: pathname,
          method: "GET",
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
      logEvent(
        "review.order_status.list.fail",
        {
          path: pathname,
          method: "GET",
          errorCode: ErrorCode.AUTH_LOGIN_REQUIRED,
          reason: "missing_logged_in_customer_id",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
        correlationId,
      );
    }

    const validatedInput = reviewOrderStatusQuerySchema.parse({
      orderIds: parseOrderIdsFromQuery(url),
      loggedInCustomerId: customerId,
    });

    logEvent(
      "review.order_status.list.attempt",
      {
        path: pathname,
        method: "GET",
        orderCount: validatedInput.orderIds.length,
      },
      { correlationId, shop },
    );

    const result = await listCustomerReviewStatusByOrders({
      shop,
      customerId: validatedInput.loggedInCustomerId,
      orderIds: validatedInput.orderIds,
      correlationId,
    });

    logEvent(
      "review.order_status.list.success",
      {
        path: pathname,
        method: "GET",
        orderCount: validatedInput.orderIds.length,
        reviewedCount: result.items.filter((item) => item.reviewed).length,
        durationMs: Date.now() - startTime,
      },
      { correlationId, shop },
    );

    return respond.ok({ items: result.items }, { correlationId });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");

      logEvent(
        "review.order_status.list.fail",
        {
          path: pathname,
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
        "review.order_status.list.fail",
        {
          path: pathname,
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
      "review.order_status.list.fail",
      {
        path: pathname,
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
