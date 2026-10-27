import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  entitlementDeleteSchema,
  entitlementUpsertSchema,
} from "~/lib/gkv/adminSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId")?.trim();
  if (!customerId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId 쿼리가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const items = await prisma.gkvEntitlement.findMany({
    where: { customerId },
    orderBy: [{ updatedAt: "desc" }],
  });
  return respond.ok({ items }, { correlationId });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);

  try {
    if (request.method === "DELETE") {
      const payload = entitlementDeleteSchema.parse(await request.json());
      await prisma.gkvEntitlement.delete({
        where: {
          customerId_guideId: {
            customerId: payload.customerId,
            guideId: payload.guideId,
          },
        },
      });
      return respond.ok({ deleted: true }, { correlationId });
    }

    if (request.method !== "POST") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const payload = entitlementUpsertSchema.parse(await request.json());
    await prisma.gkvCustomer.upsert({
      where: { customerId: payload.customerId },
      create: { customerId: payload.customerId },
      update: {},
    });
    await prisma.gkvEntitlement.upsert({
      where: {
        customerId_guideId: {
          customerId: payload.customerId,
          guideId: payload.guideId,
        },
      },
      create: {
        customerId: payload.customerId,
        guideId: payload.guideId,
        expiresAt: new Date(payload.expiresAt),
        status: payload.status,
        sourceOrderId: payload.sourceOrderId,
      },
      update: {
        expiresAt: new Date(payload.expiresAt),
        status: payload.status,
        sourceOrderId: payload.sourceOrderId,
      },
    });
    return respond.ok({ upserted: true }, { correlationId });
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
