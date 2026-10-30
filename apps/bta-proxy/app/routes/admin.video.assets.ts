import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import { listScopedAssets, upsertScopedAsset } from "~/domains/guide-viewer/adminContent.server.ts";
import {
  parseQueryBoolean,
  parseQueryInt,
  toValidationFailResponse,
} from "~/domains/guide-viewer/adminUiResponses";
import { videoAssetUpsertSchema } from "~/domains/guide-viewer/adminUiSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

const KIND = "VIDEO" as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }

  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const limit = parseQueryInt(url.searchParams.get("limit"), { min: 1, max: 200, fallback: 50 });

  const data = await listScopedAssets(KIND, {
    q: url.searchParams.get("q"),
    categoryId: url.searchParams.get("categoryId"),
    status: url.searchParams.get("status"),
    hasThumbnail: parseQueryBoolean(url.searchParams.get("hasThumbnail")),
    isActive: parseQueryBoolean(url.searchParams.get("isActive")),
    limit,
    cursor: url.searchParams.get("cursor"),
  });

  return respond.ok(data, { correlationId });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }

  const correlationId = respond.getCorrelationId(request);
  if (request.method !== "POST") {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
      undefined,
      405,
      correlationId,
    );
  }

  try {
    const payload = videoAssetUpsertSchema.parse(await request.json());
    const result = await upsertScopedAsset(KIND, {
      id: payload.id,
      title: payload.title,
      categoryIds: payload.categoryIds,
      file: payload.file,
      thumbnail: payload.thumbnail,
      isActive: payload.isActive,
      description: payload.description,
    });
    return respond.ok(result, { correlationId });
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
