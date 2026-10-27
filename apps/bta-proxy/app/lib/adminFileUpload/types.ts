export type UploadInput = {
  filename: string;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
  data: Buffer;
};

export type UploadResult = {
  fileId: string;
  sourceUrl?: string;
  alt?: string;
  status?: string;
  previewUrl?: string;
};

export enum UploadErrorCode {
  STAGED_UPLOAD_FAILED = "STAGED_UPLOAD_FAILED",
  HTTP_UPLOAD_FAILED = "HTTP_UPLOAD_FAILED",
  FILE_CREATE_FAILED = "FILE_CREATE_FAILED",
  INVALID_FILE = "INVALID_FILE",
  TOO_LARGE = "TOO_LARGE",
  INVALID_TYPE = "INVALID_TYPE",
}

export type UploadErrorDetails = {
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export class UploadError extends Error {
  code: UploadErrorCode;
  details?: UploadErrorDetails;
  stage?: string;
  reason?: string;

  constructor(
    code: UploadErrorCode,
    message: string,
    details?: UploadErrorDetails
  ) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.details = details;
  }
}
