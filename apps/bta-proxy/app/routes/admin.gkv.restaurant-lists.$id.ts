import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { restaurantListUpdateSchema } from "~/domains/guide-viewer/adminSchemas";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);
  const id = params.id;

  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "restaurant list id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    if (request.method === "DELETE") {
      await prisma.gkvRestaurantList.delete({ where: { id } });
      return respond.ok({ id, deleted: true }, { correlationId });
    }

    if (request.method !== "PUT") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const payload = restaurantListUpdateSchema.parse(await request.json());
    await prisma.gkvRestaurantList.update({
      where: { id },
      data: {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.city !== undefined ? { city: payload.city } : {}),
        ...(payload.country !== undefined ? { country: payload.country } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      },
    });

    return respond.ok({ id, updated: true }, { correlationId });
  } catch {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
