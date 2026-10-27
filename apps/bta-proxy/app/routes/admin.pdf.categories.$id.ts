import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  deleteScopedCategory,
  resolveSlug,
  updateScopedCategory,
} from "~/lib/gkv/adminContent.server";
import { toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import { scopedCategoryUpdateSchema } from "~/lib/gkv/adminUiSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

const KIND = "PDF" as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);
  const id = params.id;
  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "category id가 필요합니다."),
      undefined,
      400,
      correlationId
    );
  }

  const item = await prisma.gkvCategory.findUnique({ where: { id } });
  if (!item) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "카테고리를 찾을 수 없습니다."),
      undefined,
      404,
      correlationId
    );
  }

  return respond.ok(
    {
      item: {
        id: item.id,
        kind: "SHARED",
        name: item.name,
        slug: item.slug,
        depth: item.depth,
        parentId: item.parentId,
        sortOrder: item.sortOrder,
        isActive: item.isActive,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      },
    },
    { correlationId }
  );
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);
  const id = params.id;
  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "category id가 필요합니다."),
      undefined,
      400,
      correlationId
    );
  }

  try {
    if (request.method === "DELETE") {
      const data = await deleteScopedCategory(KIND, id);
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

    const payload = scopedCategoryUpdateSchema.parse(await request.json());
    const updated = await updateScopedCategory(KIND, id, {
      ...payload,
      ...(payload.slug !== undefined
        ? { slug: resolveSlug(payload.slug, payload.name ?? "") }
        : {}),
    });
    return respond.ok(updated, { correlationId });
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
