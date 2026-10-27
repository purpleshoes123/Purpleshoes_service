import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { restaurantItemUpdateSchema } from "~/lib/gkv/adminSchemas";
import { toRestaurantPhotoData } from "~/lib/gkv/restaurantPhotoUrls.server";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);
  const itemId = params.itemId;

  if (!itemId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "restaurant item id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  try {
    if (request.method === "DELETE") {
      await prisma.$transaction(async (tx) => {
        await tx.gkvRestaurantDietary.deleteMany({ where: { restaurantId: itemId } });
        await tx.gkvRestaurantItem.delete({ where: { id: itemId } });
      });
      return respond.ok({ id: itemId, deleted: true }, { correlationId });
    }

    if (request.method !== "PUT") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const payload = restaurantItemUpdateSchema.parse(await request.json());
    await prisma.$transaction(async (tx) => {
      await tx.gkvRestaurantItem.update({
        where: { id: itemId },
        data: {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.category !== undefined ? { category: payload.category } : {}),
          ...(payload.address !== undefined ? { address: payload.address } : {}),
          ...(payload.lat !== undefined ? { lat: payload.lat } : {}),
          ...(payload.lng !== undefined ? { lng: payload.lng } : {}),
          ...(payload.tags !== undefined ? { tags: JSON.stringify(payload.tags) } : {}),
          ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
          ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
          ...(payload.mapUrl !== undefined ? { mapUrl: payload.mapUrl } : {}),
          ...(payload.photo !== undefined ? toRestaurantPhotoData(payload.photo) : {}),
        },
      });
      if (payload.dietary) {
        await tx.gkvRestaurantDietary.upsert({
          where: { restaurantId: itemId },
          create: {
            restaurantId: itemId,
            isVeganOnly: payload.dietary.isVeganOnly,
            hasVeganOptions: payload.dietary.hasVeganOptions,
            veganLevel: payload.dietary.veganLevel,
            meatTypes: JSON.stringify(payload.dietary.meatTypes),
            halalLevel: payload.dietary.halalLevel,
            notes: payload.dietary.notes,
          },
          update: {
            isVeganOnly: payload.dietary.isVeganOnly,
            hasVeganOptions: payload.dietary.hasVeganOptions,
            veganLevel: payload.dietary.veganLevel,
            meatTypes: JSON.stringify(payload.dietary.meatTypes),
            halalLevel: payload.dietary.halalLevel,
            notes: payload.dietary.notes,
          },
        });
      }
    });

    return respond.ok({ id: itemId, updated: true }, { correlationId });
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
