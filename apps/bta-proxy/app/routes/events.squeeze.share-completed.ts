import type { ActionFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { shareCompletedSchema } from "~/lib/coupons/validation";
import { getShareIntentCustomerId, issueExtra10, tryMarkEventOnce } from "~/lib/coupons";
import { normalizeCustomerId } from "~/lib/coupons/normalize";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";

function verifySqueezeToken(request: Request): Response | null {
  const expected = process.env.SQUEEZE_EVENT_TOKEN;
  if (!expected) return null;
  const provided = request.headers.get("X-Squeeze-Event-Token");
  if (!provided || provided !== expected) {
    const correlationId = respond.getCorrelationId(request);
    return respond.fail(
      ErrorCode.INTERNAL_AUTH_INVALID,
      getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID, "공유 이벤트 인증 실패"),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
      correlationId
    );
  }
  return null;
}

/**
 * POST /events/squeeze/share-completed
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifySqueezeToken(request);
  if (authResponse) return authResponse;

  try {
    const body = await request.json();
    const validated = shareCompletedSchema.parse(body);

    const intentCustomerIdRaw = await getShareIntentCustomerId(
      validated.shareEventId
    );
    if (!intentCustomerIdRaw) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shareEventId가 유효하지 않습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const intentCustomerId = normalizeCustomerId(intentCustomerIdRaw);
    if (!intentCustomerId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId가 유효하지 않습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    if (validated.customerId) {
      const provided = normalizeCustomerId(validated.customerId);
      if (provided && provided !== intentCustomerId) {
        return respond.fail(
          ErrorCode.INTERNAL_AUTH_INVALID,
          getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID, "customerId가 일치하지 않습니다."),
          undefined,
          getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
          correlationId
        );
      }
    }

    const marked = await tryMarkEventOnce(
      "share_completed",
      validated.shareEventId,
      30 * 24 * 60 * 60
    );
    if (!marked) {
      return respond.ok(
        { ok: true, duplicate: true, extra10Code: null },
        { correlationId }
      );
    }

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

    const issueResult = await issueExtra10(admin, intentCustomerId);
    return respond.ok(
      {
        ok: true,
        duplicate: false,
        extra10Code: issueResult.code,
        issued: issueResult.issued,
        reason: issueResult.reason,
      },
      { correlationId }
    );
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
