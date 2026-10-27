import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  listRestaurantCategories,
  upsertRestaurantCategory,
} from "~/lib/gkv/adminRestaurant.server";
import { parseQueryBoolean, toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import { restaurantCategoryUpsertSchema } from "~/lib/gkv/adminUiSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const includeInactive = parseQueryBoolean(url.searchParams.get("includeInactive")) ?? false;
  const data = await listRestaurantCategories(includeInactive);
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
    const payload = restaurantCategoryUpsertSchema.parse(await request.json());
    const data = await upsertRestaurantCategory({
      id: payload.id,
      name: payload.name,
      slug: payload.slug,
      sortOrder: payload.sortOrder,
      isActive: payload.isActive,
    });
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
