import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { extractCustomerIdFromProxyRequest } from "~/lib/guideExtension/customerId";
import { refreshCreditsForCustomer } from "~/lib/tourCredits/creditRefreshService";
import { getTourPending, clearTourPending } from "~/lib/tourCheckout/pending";
import { revokeCode } from "~/lib/coupons/issuer";

async function handle(request: Request) {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

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
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "로그인이 필요합니다."),
      undefined,
      403,
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

  const warnings: string[] = [];
  const pending = await getTourPending(customerId);
  if (pending) {
    try {
      await revokeCode(admin, customerId, pending.code, pending.discountId || undefined);
    } catch (error) {
      warnings.push(
        `PENDING_REVOKE_FAILED:${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      await clearTourPending(customerId);
    }
  }

  let result;
  try {
    result = await refreshCreditsForCustomer({
      admin,
      shop,
      customerId,
      limit: 50,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Tour credit refresh failed",
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

  if (result.locked) {
    return respond.fail(
      ErrorCode.INTERNAL_CONFLICT,
      getErrorMessage(ErrorCode.INTERNAL_CONFLICT),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_CONFLICT),
      correlationId
    );
  }

  return respond.ok(
    {
      creditBalance: result.creditBalance,
      newlyGrantedOrderIds: result.newlyGrantedOrderIds,
      warnings: [...warnings, ...result.warnings],
    },
    { correlationId }
  );
}

/**
 * GET /proxy/bta/tour/credit-status
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return handle(request);
};

/**
 * POST /proxy/bta/tour/credit-status
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  return handle(request);
};
