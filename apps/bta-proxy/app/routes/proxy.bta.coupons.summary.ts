import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { extractCustomerIdFromProxyRequest } from "~/lib/guideExtension/customerId";
import { buildCouponSummary } from "~/lib/couponDisplay/summary";

/**
 * GET /proxy/bta/coupons/summary
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  const correlationId = respond.getCorrelationId(request);

  const shop = extractShopFromRequest(request);
  if (!shop) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const customerId = extractCustomerIdFromProxyRequest(request);
  if (!customerId) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return respond.fail(
      ErrorCode.SHOPIFY_ADMIN_API_ERROR,
      getErrorMessage(
        ErrorCode.SHOPIFY_ADMIN_API_ERROR,
        "Shopify Admin API 세션을 찾을 수 없습니다."
      ),
      undefined,
      getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      correlationId
    );
  }

  try {
    const summary = await buildCouponSummary({ admin, customerId });
    return respond.ok(summary, { correlationId });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Coupon summary failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
