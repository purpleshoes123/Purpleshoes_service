import type { ActionFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { assetUploadUrlSchema } from "~/domains/guide-viewer/adminSchemas";
import { buildAssetUploadUrl } from "~/domains/guide-viewer/uploadUrl.server.ts";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);

  try {
    const payload = assetUploadUrlSchema.parse(await request.json());
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
      { correlationId },
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((i) => i.message).join(", "),
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
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
