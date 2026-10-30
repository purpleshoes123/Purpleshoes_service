import {
  UploadError,
  UploadErrorCode,
  type UploadInput,
} from "~/domains/catalog/adminFileUpload/types";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export function validateUploadInput(input: UploadInput): UploadInput {
  if (input.mimeType !== "image/jpeg" && input.mimeType !== "image/png") {
    throw new UploadError(UploadErrorCode.INVALID_TYPE, "지원하지 않는 파일 형식입니다.", {
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
  }

  if (input.sizeBytes > MAX_FILE_SIZE_BYTES || input.sizeBytes < 0) {
    throw new UploadError(UploadErrorCode.TOO_LARGE, "파일 크기가 허용 범위를 초과합니다.", {
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
  }

  if (input.data.length !== input.sizeBytes) {
    throw new UploadError(
      UploadErrorCode.INVALID_FILE,
      "파일 크기 정보가 실제 데이터와 일치하지 않습니다.",
      {
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
    );
  }

  return input;
}
