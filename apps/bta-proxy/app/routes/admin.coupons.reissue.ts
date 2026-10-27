import type { ActionFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { verifyAdminApiKey } from "~/middleware/verifyAdminApiKey";
import { adminReissueSchema } from "~/lib/coupons/validation";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { issueGuide50, issueExtra10, revokeCode } from "~/lib/coupons/issuer";
import { getState } from "~/lib/coupons/state";
import { normalizeCustomerId } from "~/lib/coupons/normalize";
import { acquireLock, releaseLock } from "~/lib/coupons/lock";

function resolveOldCode(kind: string, state: any): { code: string | null; discountId: string | null } {
  if (kind === "GUIDE50") {
    return { code: state.guide50Code, discountId: state.guide50DiscountId };
  }
  if (kind === "EXTRA10") {
    return { code: state.extra10Code, discountId: state.extra10DiscountId };
  }
  return { code: null, discountId: null };
}

/**
 * POST /admin/coupons/reissue
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifyAdminApiKey(request);
  if (authResponse) return authResponse;

  try {
    const body = await request.json();
    const validated = adminReissueSchema.parse(body);
    const customerId = normalizeCustomerId(validated.customerId);
    if (!customerId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const lockOk = await acquireLock("adminReissue", customerId, 20);
    if (!lockOk) {
      return respond.fail(
        ErrorCode.INTERNAL_CONFLICT,
        getErrorMessage(ErrorCode.INTERNAL_CONFLICT),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_CONFLICT),
        correlationId
      );
    }

    try {
      const url = new URL(request.url);
      const shop = url.searchParams.get("shop") || body.shop;
      if (!shop) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
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

      if (validated.couponKind !== "GUIDE50" && validated.couponKind !== "EXTRA10") {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            `couponKind ${validated.couponKind} 지원되지 않습니다.`
          ),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
        );
      }

      const state = await getState(customerId);
      const resolved = resolveOldCode(validated.couponKind, state);
      const oldCode = resolved.code;
      const oldDiscountId = resolved.discountId;

      if (oldCode) {
        await revokeCode(admin, customerId, oldCode, oldDiscountId);
      }

      if (validated.couponKind === "GUIDE50") {
        const result = await issueGuide50(admin, customerId, { force: true });
        return respond.ok(
          {
            ok: true,
            couponKind: validated.couponKind,
            oldCode,
            newCode: result.code,
            issued: result.issued,
            reason: result.reason,
          },
          { correlationId }
        );
      }

      const result = await issueExtra10(admin, customerId, { force: true });
      return respond.ok(
        {
          ok: true,
          couponKind: validated.couponKind,
          oldCode,
          newCode: result.code,
          issued: result.issued,
          reason: result.reason,
        },
        { correlationId }
      );
    } finally {
      await releaseLock("adminReissue", customerId);
    }
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues
        .map((issue) => issue.message)
        .join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
