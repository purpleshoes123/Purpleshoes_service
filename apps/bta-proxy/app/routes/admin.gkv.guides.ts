import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { guideCreateSchema } from "~/lib/gkv/adminSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);
  const items = await prisma.gkvGuide.findMany({
    orderBy: [{ updatedAt: "desc" }],
  });
  return respond.ok({ items }, { correlationId });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);
  try {
    const payload = guideCreateSchema.parse(await request.json());
    const id = payload.id ?? `guide_${randomUUID()}`;
    const created = await prisma.gkvGuide.create({
      data: {
        id,
        title: payload.title,
        type: payload.type,
        thumbnailUrl: payload.thumbnailUrl,
        isActive: payload.isActive,
      },
    });
    return respond.ok({ id: created.id }, { correlationId });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((i) => i.message).join(", ")
        ),
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
