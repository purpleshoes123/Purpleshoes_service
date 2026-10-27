import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { verifyGkvWebhookSignature } from "~/lib/gkv/webhookAuth";

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const raw = await request.text();
  const sig = request.headers.get("X-GKV-Signature");
  if (!verifyGkvWebhookSignature(raw, sig)) {
    return respond.fail(
      ErrorCode.INTERNAL_AUTH_INVALID,
      getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
      correlationId
    );
  }

  let payload: { customerId?: string; guideId?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "웹훅 payload JSON 파싱 실패"),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }
  if (!payload.customerId || !payload.guideId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId/guideId가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  await prisma.gkvEntitlement.updateMany({
    where: { customerId: payload.customerId, guideId: payload.guideId },
    data: { status: "REVOKED" },
  });
  return respond.ok({ revoked: true }, { correlationId });
};
