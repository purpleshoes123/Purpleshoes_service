import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { createFileRecord } from "~/lib/adminFileUpload/createFileRecord";
import { createStagedUploadTarget } from "~/lib/adminFileUpload/createStagedTarget";
import { uploadToStagedTarget } from "~/lib/adminFileUpload/uploadHttp";
import {
  UploadError,
  UploadErrorCode,
  type UploadInput,
  type UploadResult,
} from "~/lib/adminFileUpload/types";

function resolveStageCode(stage: string): UploadErrorCode {
  if (stage === "createStagedTarget") return UploadErrorCode.STAGED_UPLOAD_FAILED;
  if (stage === "uploadToStagedTarget") return UploadErrorCode.HTTP_UPLOAD_FAILED;
  return UploadErrorCode.FILE_CREATE_FAILED;
}

function withStage(error: unknown, stage: string): never {
  if (error instanceof UploadError) {
    error.stage = stage;
    error.message = `stage=${stage} ${error.message}`;
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new UploadError(resolveStageCode(stage), message || "upload failed");
  wrapped.stage = stage;
  wrapped.message = `stage=${stage} ${wrapped.message}`;
  throw wrapped;
}

export async function uploadImageToShopifyFiles(
  adminClient: AdminApiContext,
  file: UploadInput,
  alt?: string
): Promise<UploadResult> {
  let target;
  try {
    target = await createStagedUploadTarget(adminClient, file);
  } catch (error) {
    withStage(error, "createStagedTarget");
  }

  try {
    await uploadToStagedTarget(target, file);
  } catch (error) {
    withStage(error, "uploadToStagedTarget");
  }

  try {
    const result = await createFileRecord(
      adminClient,
      target.resourceUrl,
      alt,
      file.mimeType
    );
    return {
      ...result,
      sourceUrl: target.resourceUrl,
    };
  } catch (error) {
    withStage(error, "createFileRecord");
  }
}
