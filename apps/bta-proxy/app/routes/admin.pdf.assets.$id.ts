import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  deleteScopedAsset,
  getScopedAsset,
  upsertScopedAsset,
} from "~/lib/gkv/adminContent.server";
import { toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import { pdfAssetUpsertSchema } from "~/lib/gkv/adminUiSchemas";
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
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset id가 필요합니다."),
      undefined,
      400,
      correlationId
    );
  }

  const item = await getScopedAsset(KIND, id);
  if (!item) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "에셋을 찾을 수 없습니다."),
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
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset id가 필요합니다."),
      undefined,
      400,
      correlationId
    );
  }

  try {
    if (request.method === "DELETE") {
      const data = await deleteScopedAsset(KIND, id);
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

    const payload = pdfAssetUpsertSchema.parse(await request.json());
    const data = await upsertScopedAsset(
      KIND,
      {
        id,
        title: payload.title,
        categoryIds: payload.categoryIds,
        file: payload.file,
        thumbnail: payload.thumbnail,
        isActive: payload.isActive,
        description: payload.description,
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
