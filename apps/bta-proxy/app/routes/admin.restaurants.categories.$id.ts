import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  deleteRestaurantCategory,
  upsertRestaurantCategory,
} from "~/domains/guide-viewer/adminRestaurant.server.ts";
import { toValidationFailResponse } from "~/domains/guide-viewer/adminUiResponses";
import { restaurantCategoryUpsertSchema } from "~/domains/guide-viewer/adminUiSchemas";
import { respond } from "~/lib/respond";
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
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "category id가 필요합니다."),
      undefined,
      400,
      correlationId,
    );
  }

  try {
    if (request.method === "DELETE") {
      const data = await deleteRestaurantCategory(id);
      return respond.ok(data, { correlationId });
    }

    if (request.method !== "PUT") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
        undefined,
        405,
        correlationId,
      );
    }

    const payload = restaurantCategoryUpsertSchema.parse(await request.json());
    const data = await upsertRestaurantCategory(
      {
        id,
        name: payload.name,
        slug: payload.slug,
        sortOrder: payload.sortOrder,
        isActive: payload.isActive,
      },
      id,
    );
    return respond.ok(data, { correlationId });
  } catch (error) {
    if (error instanceof ZodError) {
      return toValidationFailResponse(request, error);
    }

    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "동일 slug가 이미 존재합니다."),
        { fieldErrors: { slug: "이미 사용 중인 slug입니다." } },
        422,
        correlationId,
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      500,
      correlationId,
    );
  }
};
