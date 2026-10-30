import {
  UploadError,
  UploadErrorCode,
  type UploadInput,
} from "~/domains/catalog/adminFileUpload/types";
import type { StagedTargetDTO } from "~/domains/catalog/adminFileUpload/stagedUploadQuery";
import { validateUploadInput } from "~/domains/catalog/adminFileUpload/validate";

const SUCCESS_STATUSES = new Set([200, 201, 204]);

function extractSignedHeaders(targetUrl: string): string[] | null {
  try {
    const url = new URL(targetUrl);
    for (const [key, value] of url.searchParams) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "x-goog-signedheaders" || lowerKey === "x-amz-signedheaders") {
        const headers = value
          .split(";")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
        return headers.length > 0 ? headers : [];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function shouldUsePut(urlHost: string, paramNames: string[]): boolean {
  if (paramNames.length === 0) {
    return true;
  }
  const lowerNames = paramNames.map((name) => name.toLowerCase());
  const hasSignatureLike = lowerNames.some(
    (name) =>
      name === "policy" ||
      name === "signature" ||
      name === "key" ||
      name.startsWith("x-amz-") ||
      name.startsWith("x-goog-"),
  );
  if (hasSignatureLike) {
    return false;
  }
  if (urlHost.endsWith("storage.googleapis.com")) {
    return true;
  }
  const onlyHeaders = lowerNames.every(
    (name) =>
      name === "content_type" ||
      name === "content-type" ||
      name === "acl" ||
      name === "x-goog-meta-mimetype",
  );
  return onlyHeaders;
}

function buildPutHeaders(
  urlHost: string,
  file: UploadInput,
  params: Array<{ name: string; value: string }>,
  signedHeaders: string[] | null,
): Record<string, string> {
  const allowed = signedHeaders ? new Set(signedHeaders) : null;
  const allow = (name: string): boolean => !allowed || allowed.has(name.toLowerCase());
  const headers: Record<string, string> = {};
  if (allow("content-type")) {
    headers["Content-Type"] = file.mimeType;
  }
  if (allow("content-length")) {
    headers["Content-Length"] = String(file.sizeBytes);
  }
  for (const param of params) {
    const nameLower = param.name.toLowerCase();
    if (nameLower === "content_type" || nameLower === "content-type") {
      if (allow("content-type")) {
        headers["Content-Type"] = param.value;
      }
      continue;
    }
    if (nameLower === "acl") {
      const aclHeader = urlHost.endsWith("storage.googleapis.com") ? "x-goog-acl" : "x-amz-acl";
      if (allow(aclHeader)) {
        headers[aclHeader] = param.value;
      }
      continue;
    }
    if (nameLower.startsWith("x-goog-") || nameLower.startsWith("x-amz-")) {
      if (allow(nameLower)) {
        headers[param.name] = param.value;
      }
    }
  }
  return headers;
}

export async function uploadToStagedTarget(
  target: StagedTargetDTO,
  file: UploadInput,
): Promise<void> {
  validateUploadInput(file);

  const paramNames = target.parameters.map((param) => param.name);
  const contentTypeParamName = target.parameters.find((param) => {
    const name = param.name.toLowerCase();
    return (
      name === "content-type" ||
      name === "content_type" ||
      name === "contenttype" ||
      name === "x-goog-meta-mimetype"
    );
  })?.name;
  const urlHost = (() => {
    try {
      return new URL(target.url).host;
    } catch {
      return "";
    }
  })();
  const signedHeaders = extractSignedHeaders(target.url);

  const usePut = shouldUsePut(urlHost, paramNames);

  if (usePut) {
    const putHeaders = buildPutHeaders(urlHost, file, target.parameters, signedHeaders);
    const response = await fetch(target.url, {
      method: "PUT",
      headers: putHeaders,
      body: file.data,
    });

    if (!SUCCESS_STATUSES.has(response.status)) {
      let errorReason = `http_status=${response.status}`;
      try {
        const text = await response.text();
        const codeMatch = text.match(/<Code>([^<]+)<\/Code>/i);
        if (codeMatch?.[1]) {
          errorReason = `${errorReason}; code=${codeMatch[1]}`;
        }
      } catch (error) {
        errorReason = `http_status=${response.status}`;
      }

      const uploadError = new UploadError(
        UploadErrorCode.HTTP_UPLOAD_FAILED,
        `staged upload 실패 (status=${response.status})`,
        {
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        },
      );
      uploadError.reason = errorReason;
      throw uploadError;
    }
    return;
  }

  const formData = new FormData();
  for (const param of target.parameters) {
    formData.append(param.name, param.value);
  }
  const contentTypeParam = target.parameters.find(
    (param) => param.name.toLowerCase() === contentTypeParamName?.toLowerCase(),
  );
  const fileContentType = contentTypeParam?.value || file.mimeType;
  const hasFile = typeof File !== "undefined";
  const hasBlob = typeof Blob !== "undefined";
  if (hasFile) {
    const fileBlob = new File([file.data], file.filename, { type: fileContentType });
    formData.append("file", fileBlob);
  } else if (hasBlob) {
    const blob = new Blob([file.data], { type: fileContentType });
    formData.append("file", blob, file.filename);
  } else {
    formData.append("file", file.data as unknown as string);
  }

  const response = await fetch(target.url, {
    method: "POST",
    body: formData,
  });

  if (!SUCCESS_STATUSES.has(response.status)) {
    let errorReason = `http_status=${response.status}`;
    try {
      const text = await response.text();
      const codeMatch = text.match(/<Code>([^<]+)<\/Code>/i);
      if (codeMatch?.[1]) {
        errorReason = `${errorReason}; code=${codeMatch[1]}`;
      }
    } catch (error) {
      errorReason = `http_status=${response.status}`;
    }

    const uploadError = new UploadError(
      UploadErrorCode.HTTP_UPLOAD_FAILED,
      `staged upload 실패 (status=${response.status})`,
      {
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      },
    );
    uploadError.reason = errorReason;
    throw uploadError;
  }
}
