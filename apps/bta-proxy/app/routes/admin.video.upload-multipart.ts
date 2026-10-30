import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import {
  multipartUploadCompleteRequestSchema,
  multipartUploadPartsRequestSchema,
  videoMultipartStartRequestSchema,
} from "~/domains/guide-viewer/adminUiSchemas";
import { toValidationFailResponse } from "~/domains/guide-viewer/adminUiResponses";
import {
  abortMultipartAssetUpload,
  completeMultipartAssetUpload,
  signMultipartUploadParts,
  startMultipartAssetUpload,
} from "~/domains/guide-viewer/uploadUrl.server.ts";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

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
    const payload = (await request.json()) as { intent?: unknown };
    const intent = String(payload.intent || "");

    if (intent === "start") {
      const input = videoMultipartStartRequestSchema.parse(payload);
      return respond.ok(
        await startMultipartAssetUpload({
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSizeBytes: input.fileSizeBytes,
        }),
        { correlationId },
      );
    }

    if (intent === "sign-parts") {
      const input = multipartUploadPartsRequestSchema.parse(payload);
      return respond.ok({ parts: await signMultipartUploadParts(input) }, { correlationId });
    }

    if (intent === "complete") {
      const input = multipartUploadCompleteRequestSchema.parse(payload);
      return respond.ok(await completeMultipartAssetUpload(input), { correlationId });
    }

    if (intent === "abort") {
      const input = zAbortRequestSchema.parse(payload);
      await abortMultipartAssetUpload(input);
      return respond.ok({ aborted: true }, { correlationId });
    }

    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 multipart upload 요청입니다."),
      undefined,
      422,
      correlationId,
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return toValidationFailResponse(request, error);
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      error instanceof Error ? error.message : getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      500,
      correlationId,
    );
  }
};

const zAbortRequestSchema = multipartUploadPartsRequestSchema.pick({ uploadToken: true });
