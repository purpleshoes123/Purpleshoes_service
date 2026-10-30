import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { requireGkvCustomerId } from "~/domains/guide-viewer/customerAuth";
import { respond } from "~/lib/respond";
import { z } from "zod";

const schema = z
  .object({
    sessionId: z.string().trim().min(1).optional(),
    deviceId: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.sessionId && !data.deviceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionId"],
        message: "sessionId 또는 deviceId가 필요합니다.",
      });
    }
  });

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) {
    return auth;
  }
  const correlationId = respond.getCorrelationId(request);

  if (request.method.toUpperCase() !== "POST") {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "Unsupported method."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    const payload = schema.parse(await request.json());
    const now = new Date();
    const updated = await prisma.gkvSession.updateMany({
      where: {
        customerId: auth.customerId,
        revokedAt: null,
        ...(payload.sessionId ? { id: payload.sessionId } : {}),
        ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
      },
      data: { revokedAt: now },
    });

    console.log(
      JSON.stringify({
        message: "GKV session ended by customer",
        customerIdMasked: auth.customerId.slice(-4),
        sessionId: payload.sessionId || null,
        deviceId: payload.deviceId || null,
        revokedCount: updated.count,
      }),
    );

    return respond.ok(
      {
        revokedCount: updated.count,
        endedAt: now.toISOString(),
      },
      { correlationId },
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((issue) => issue.message).join(", "),
        ),
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
