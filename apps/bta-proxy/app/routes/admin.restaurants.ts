import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  listRestaurants,
  upsertRestaurant,
} from "~/lib/gkv/adminRestaurant.server";
import { parseCsv, parseQueryBoolean, parseQueryInt, toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import {
  gkvMeatTypeSchema,
  restaurantUpsertSchema,
} from "~/lib/gkv/adminUiSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const meatTokens = parseCsv(url.searchParams.get("meatTypes"));
  const meatTypes = meatTokens
    .map((value) => {
      const parsed = gkvMeatTypeSchema.safeParse(value.toUpperCase());
      return parsed.success ? parsed.data : null;
    })
    .filter((value): value is (typeof gkvMeatTypeSchema)["_output"] => Boolean(value));

  const data = await listRestaurants({
    q: url.searchParams.get("q")?.trim() || undefined,
    categoryIds: parseCsv(url.searchParams.get("categoryIds")),
    areaId: url.searchParams.get("areaId")?.trim() || undefined,
    veganRecommended: parseQueryBoolean(url.searchParams.get("veganRecommended")),
    meatTypes,
    isActive: parseQueryBoolean(url.searchParams.get("isActive")),
    sort:
      (url.searchParams.get("sort") as "priority" | "newest" | "name" | null) ??
      "priority",
    limit: parseQueryInt(url.searchParams.get("limit"), { min: 1, max: 200, fallback: 50 }),
    page: parseQueryInt(url.searchParams.get("page"), { min: 1, fallback: 1 }),
    cursor: url.searchParams.get("cursor")?.trim() || undefined,
  });

  return respond.ok(data, { correlationId });
};

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
    const payload = restaurantUpsertSchema.parse(await request.json());
    const data = await upsertRestaurant({
      id: payload.id,
      name: payload.name,
      areaId: payload.areaId,
      categoryIds: payload.categoryIds,
      veganRecommended: payload.veganRecommended,
      meatTypes: payload.meatTypes,
      address: payload.address,
      lat: payload.lat,
      lng: payload.lng,
      kakaoPlaceId: payload.kakaoPlaceId,
      naverPlaceUrl: payload.naverPlaceUrl,
      tags: payload.tags,
      memo: payload.memo,
      priority: payload.priority,
      isActive: payload.isActive,
      photo: payload.photo,
    });
    return respond.ok(data, { correlationId });
  } catch (error) {
    if (error instanceof ZodError) {
      return toValidationFailResponse(request, error);
    }

    if (error instanceof Error) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, error.message),
        { fieldErrors: { form: error.message } },
        422,
        correlationId
      );
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
