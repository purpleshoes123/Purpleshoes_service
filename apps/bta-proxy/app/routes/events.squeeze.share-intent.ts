import type { ActionFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { shareIntentSchema } from "~/domains/coupons/validation";
import { setShareIntent } from "~/domains/coupons";
import { normalizeCustomerId } from "~/domains/coupons/normalize";

function verifySqueezeToken(request: Request): Response | null {
  const expected = process.env.SQUEEZE_EVENT_TOKEN;
  if (!expected) {
    return null;
  }
  const provided = request.headers.get("X-Squeeze-Event-Token");
  if (!provided || provided !== expected) {
    const correlationId = respond.getCorrelationId(request);
    return respond.fail(
      ErrorCode.INTERNAL_AUTH_INVALID,
      getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID, "공유 이벤트 인증 실패"),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
      correlationId,
    );
  }
  return null;
}

/**
 * POST /events/squeeze/share-intent
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifySqueezeToken(request);
  if (authResponse) {
    return authResponse;
  }

  try {
    const body = await request.json();
    const validated = shareIntentSchema.parse(body);
    const customerId = normalizeCustomerId(validated.customerId);
    if (!customerId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const shareEventId = randomUUID();
    const ttlSeconds = Number(process.env.COUPON_SHARE_INTENT_TTL_SEC || 3600);
    await setShareIntent(shareEventId, customerId, ttlSeconds);

    return respond.ok({ shareEventId }, { correlationId });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
