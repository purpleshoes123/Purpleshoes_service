import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import { toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import { sessionRevokeSchema } from "~/lib/gkv/adminUiSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);

  if (request.method !== "POST") {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
      undefined,
      405,
      correlationId
    );
  }

  try {
    const payload = sessionRevokeSchema.parse(await request.json());
    const now = new Date();

    if (payload.sessionId) {
      const updated = await prisma.gkvSession.updateMany({
        where: {
          id: payload.sessionId,
          customerId: payload.customerId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });

      return respond.ok({ revokedCount: updated.count }, { correlationId });
    }

    const updated = await prisma.gkvSession.updateMany({
      where: {
        customerId: payload.customerId,
        deviceId: payload.deviceId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    return respond.ok({ revokedCount: updated.count }, { correlationId });
  } catch (error) {
    if (error instanceof ZodError) {
      return toValidationFailResponse(request, error);
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      500,
      correlationId
    );
  }
};
