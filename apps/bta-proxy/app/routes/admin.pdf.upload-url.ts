import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import { toValidationFailResponse } from "~/lib/gkv/adminUiResponses";
import { uploadUrlRequestSchema } from "~/lib/gkv/adminUiSchemas";
import { buildAssetUploadUrl } from "~/lib/gkv/uploadUrl.server";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

const KIND = "PDF" as const;

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
    const payload = uploadUrlRequestSchema.parse(await request.json());
    if (![KIND, "THUMBNAIL"].includes(payload.kind)) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, `${KIND} 업로드 URL만 요청할 수 있습니다.`),
        { fieldErrors: { kind: `${KIND} 또는 THUMBNAIL만 허용됩니다.` } },
        422,
        correlationId
      );
    }

    const upload = await buildAssetUploadUrl({
      fileName: payload.fileName,
      mimeType: payload.mimeType,
    });

    return respond.ok(
      {
        assetId: upload.assetId,
        uploadUrl: upload.uploadUrl,
        s3Bucket: upload.s3Bucket,
        s3Key: upload.s3Key,
        mode: upload.mode,
      },
      { correlationId }
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return toValidationFailResponse(request, error);
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
