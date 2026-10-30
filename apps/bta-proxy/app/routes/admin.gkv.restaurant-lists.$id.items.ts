import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { restaurantItemCreateSchema } from "~/domains/guide-viewer/adminSchemas";
import {
  buildRestaurantPhotoUrls,
  serializeRestaurantPhotoMeta,
  toRestaurantPhotoData,
} from "~/domains/guide-viewer/restaurantPhotoUrls.server.ts";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

function parseMaybeJson(value: string | null | undefined): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);
  const listId = params.id;

  if (!listId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "restaurant list id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  const rows = await prisma.gkvRestaurantItem.findMany({
    where: { listId },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });

  const dietaryRows = await prisma.gkvRestaurantDietary.findMany({
    where: { restaurantId: { in: rows.map((r) => r.id) } },
  });
  const dietaryMap = new Map(dietaryRows.map((d) => [d.restaurantId, d]));

  return respond.ok(
    {
      items: rows.map((r) => {
        const dietary = dietaryMap.get(r.id);
        return {
          id: r.id,
          listId: r.listId,
          name: r.name,
          category: r.category,
          address: r.address,
          lat: r.lat,
          lng: r.lng,
          tags: (parseMaybeJson(r.tags) as string[] | null) ?? [],
          memo: r.memo,
          priority: r.priority,
          mapUrl: r.mapUrl,
          photo: serializeRestaurantPhotoMeta(r),
          ...buildRestaurantPhotoUrls(r.id, r, "admin"),
          dietary: dietary
            ? {
                isVeganOnly: dietary.isVeganOnly,
                hasVeganOptions: dietary.hasVeganOptions,
                veganLevel: dietary.veganLevel,
                meatTypes: (parseMaybeJson(dietary.meatTypes) as string[] | null) ?? [],
                halalLevel: dietary.halalLevel,
                notes: dietary.notes,
              }
            : null,
        };
      }),
    },
    { correlationId },
  );
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);
  const listId = params.id;

  if (!listId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "restaurant list id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    const payload = restaurantItemCreateSchema.parse(await request.json());
    const id = payload.id ?? `ri_${randomUUID()}`;

    await prisma.$transaction(async (tx) => {
      await tx.gkvRestaurantItem.create({
        data: {
          id,
          listId,
          name: payload.name,
          category: payload.category,
          address: payload.address,
          lat: payload.lat,
          lng: payload.lng,
          tags: payload.tags ? JSON.stringify(payload.tags) : null,
          memo: payload.memo,
          priority: payload.priority,
          mapUrl: payload.mapUrl,
          ...(payload.photo !== undefined ? toRestaurantPhotoData(payload.photo) : {}),
        },
      });
      await tx.gkvRestaurantDietary.create({
        data: {
          restaurantId: id,
          isVeganOnly: payload.dietary.isVeganOnly,
          hasVeganOptions: payload.dietary.hasVeganOptions,
          veganLevel: payload.dietary.veganLevel,
          meatTypes: JSON.stringify(payload.dietary.meatTypes),
          halalLevel: payload.dietary.halalLevel,
          notes: payload.dietary.notes,
        },
      });
    });

    return respond.ok({ id }, { correlationId });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((i) => i.message).join(", "),
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
