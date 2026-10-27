import type { ActionFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { verifyAdminApiKey } from "~/middleware/verifyAdminApiKey";
import { adminRevokeSchema } from "~/lib/coupons/validation";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { revokeCode } from "~/lib/coupons/issuer";
import { getState } from "~/lib/coupons/state";
import { normalizeCustomerId } from "~/lib/coupons/normalize";
import { acquireLock, releaseLock } from "~/lib/coupons/lock";

function resolveCodeFromState(kind: string, state: any): { code: string | null; discountId: string | null } {
  if (kind === "GUIDE50") {
    return { code: state.guide50Code, discountId: state.guide50DiscountId };
  }
  if (kind === "EXTRA10") {
    return { code: state.extra10Code, discountId: state.extra10DiscountId };
  }
  return { code: null, discountId: null };
}

/**
 * POST /admin/coupons/revoke
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifyAdminApiKey(request);
  if (authResponse) return authResponse;

  try {
    const body = await request.json();
    const validated = adminRevokeSchema.parse(body);
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

    const lockOk = await acquireLock("adminRevoke", customerId, 20);
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

      let code = validated.code || null;
      let discountId: string | null = null;
      if (!code) {
        if (!validated.couponKind) {
          return respond.fail(
            ErrorCode.VALIDATION_ERROR,
            getErrorMessage(
              ErrorCode.VALIDATION_ERROR,
              "code 또는 couponKind 중 하나는 필요합니다."
            ),
            undefined,
            getErrorStatus(ErrorCode.VALIDATION_ERROR),
            correlationId
          );
        }
        const state = await getState(customerId);
        const resolved = resolveCodeFromState(validated.couponKind, state);
        code = resolved.code;
        discountId = resolved.discountId;
      }

      if (!code) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "revoke할 코드가 없습니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
        );
      }

      await revokeCode(admin, customerId, code, discountId);

      return respond.ok({ ok: true, revokedCode: code }, { correlationId });
    } finally {
      await releaseLock("adminRevoke", customerId);
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
