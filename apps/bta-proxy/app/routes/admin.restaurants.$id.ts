import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  deactivateRestaurant,
  getRestaurant,
  upsertRestaurant,
} from "~/lib/gkv/adminRestaurant.server";
import { toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import { restaurantUpsertSchema } from "~/lib/gkv/adminUiSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);
  const id = params.id;
  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "restaurant id가 필요합니다."),
      undefined,
      400,
      correlationId
    );
  }

  const item = await getRestaurant(id);
  if (!item) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "맛집을 찾을 수 없습니다."),
      undefined,
      404,
      correlationId
    );
  }

  return respond.ok({ item }, { correlationId });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);
  const id = params.id;

  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "restaurant id가 필요합니다."),
      undefined,
      400,
      correlationId
    );
  }

  try {
    if (request.method === "DELETE") {
      const data = await deactivateRestaurant(id);
      return respond.ok(data, { correlationId });
    }

    if (request.method !== "PUT") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
        undefined,
        405,
        correlationId
      );
    }

    const payload = restaurantUpsertSchema.parse(await request.json());
    const data = await upsertRestaurant(
      {
        id,
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
      },
      id
    );
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
