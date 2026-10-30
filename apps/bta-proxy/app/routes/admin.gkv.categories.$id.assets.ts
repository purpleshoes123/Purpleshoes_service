import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  attachUnassignedAssetAsCurrent,
  deleteAssetFromCategoryContext,
  detachAssetFromCategory,
  getCategoryAssetManagement,
  promoteCategoryAsset,
} from "~/domains/guide-viewer/adminAssetUsage.server.ts";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

const actionSchema = z.object({
  intent: z.enum(["detach", "delete-asset", "promote", "attach-promote"]),
  assetId: z.string().trim().min(1),
  force: z.boolean().optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
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
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  const data = await getCategoryAssetManagement(id);
  if (!data) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "카테고리를 찾을 수 없습니다."),
      undefined,
      404,
      correlationId,
    );
  }

  return respond.ok(data, { correlationId });
};

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
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

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
    const payload = actionSchema.parse(await request.json());

    if (payload.intent === "detach") {
      return respond.ok(await detachAssetFromCategory(id, payload.assetId), { correlationId });
    }

    if (payload.intent === "delete-asset") {
      const result = await deleteAssetFromCategoryContext(id, payload.assetId, payload.force);
      if (!result.ok) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            "다른 카테고리에도 연결된 asset입니다. 먼저 연결 범위를 확인하세요.",
          ),
          { assetId: result.assetId, otherCategoryIds: result.otherCategoryIds },
          409,
          correlationId,
        );
      }
      return respond.ok(result, { correlationId });
    }

    if (payload.intent === "promote") {
      return respond.ok(await promoteCategoryAsset(id, payload.assetId), { correlationId });
    }

    return respond.ok(await attachUnassignedAssetAsCurrent(id, payload.assetId), {
      correlationId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          error.issues.map((issue) => issue.message).join(", "),
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    if (error instanceof Error) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, error.message),
        undefined,
        422,
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
