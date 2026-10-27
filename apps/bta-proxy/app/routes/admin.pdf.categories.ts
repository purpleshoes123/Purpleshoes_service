import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  createScopedCategory,
  listScopedCategories,
  resolveSlug,
} from "~/lib/gkv/adminContent.server";
import { parseQueryBoolean, toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import { scopedCategoryCreateSchema } from "~/lib/gkv/adminUiSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

const KIND = "PDF" as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const includeInactive = parseQueryBoolean(url.searchParams.get("includeInactive")) ?? false;

  const data = await listScopedCategories(KIND, includeInactive);
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
    const payload = scopedCategoryCreateSchema.parse(await request.json());
    const created = await createScopedCategory(KIND, {
      id: payload.id,
      name: payload.name,
      slug: resolveSlug(payload.slug, payload.name),
      depth: payload.depth,
      parentId: payload.parentId,
      sortOrder: payload.sortOrder,
      isActive: payload.isActive,
    });
    return respond.ok(created, { correlationId });
  } catch (error) {
    if (error instanceof ZodError) {
      return toValidationFailResponse(request, error);
    }

    if (error instanceof Error) {
      if (error.message.includes("동일 부모 아래 동일 name")) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "같은 부모 카테고리에서 이름은 고유해야 합니다."),
          { fieldErrors: { name: "같은 부모 카테고리에서 이미 사용 중인 이름입니다." } },
          422,
          correlationId
        );
      }

      if (error.message.includes("Unique constraint") || error.message.includes("동일 부모 아래 동일 slug")) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "같은 부모 카테고리에서 slug는 고유해야 합니다."),
          { fieldErrors: { slug: "같은 부모 카테고리에서 이미 사용 중인 slug입니다." } },
          422,
          correlationId
        );
      }
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
