import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getMailAttachmentExtension } from "~/domains/mail/storage";

export type MailerAttachmentUploadInput = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  data: Buffer;
};

export type MailerShopifyFile = {
  id: string;
  shopifyFileId: string;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string | null;
  fileStatus: string | null;
  contentType: "IMAGE" | "FILE" | "VIDEO";
  createdAt: string | null;
};

type MailerUploadKind = MailerShopifyFile["contentType"];

type GraphqlErrorPayload = {
  errors?: Array<{ message?: string }>;
};

const FILES_QUERY = `
  query MailerReusableFiles($first: Int!) {
    files(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes {
        __typename
        ... on GenericFile {
          id
          alt
          createdAt
          fileStatus
          mimeType
          originalFileSize
          url
          preview {
            image {
              url
            }
          }
        }
        ... on MediaImage {
          id
          alt
          createdAt
          fileStatus
          mimeType
          originalSource {
            url
            fileSize
          }
          image {
            url
          }
          preview {
            image {
              url
            }
          }
        }
        ... on Video {
          id
          alt
          createdAt
          fileStatus
          filename
          preview {
            image {
              url
            }
          }
          originalSource {
            url
            mimeType
            fileSize
          }
          sources {
            url
            mimeType
            fileSize
          }
        }
      }
    }
  }
`;

const FILE_NODE_QUERY = `
  query MailerReusableFile($id: ID!) {
    node(id: $id) {
      __typename
      ... on GenericFile {
        id
        alt
        createdAt
        fileStatus
        mimeType
        originalFileSize
        url
        preview {
          image {
            url
          }
        }
      }
      ... on MediaImage {
        id
        alt
        createdAt
        fileStatus
        mimeType
        originalSource {
          url
          fileSize
        }
        image {
          url
        }
        preview {
          image {
            url
          }
        }
      }
      ... on Video {
        id
        alt
        createdAt
        fileStatus
        filename
        preview {
          image {
            url
          }
        }
        originalSource {
          url
          mimeType
          fileSize
        }
        sources {
          url
          mimeType
          fileSize
        }
      }
    }
  }
`;

const STAGED_UPLOAD_MUTATION = `
  mutation MailerCreateStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE_MUTATION = `
  mutation MailerCreateFile($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

function getGraphqlErrors(payload: GraphqlErrorPayload) {
  return (payload.errors || []).map((item) => item.message || "").filter(Boolean);
}

function getUserErrors(payload: {
  data?: {
    stagedUploadsCreate?: { userErrors?: Array<{ message?: string }> };
    fileCreate?: { userErrors?: Array<{ message?: string }> };
  };
}) {
  const stagedErrors = payload.data?.stagedUploadsCreate?.userErrors || [];
  const fileErrors = payload.data?.fileCreate?.userErrors || [];
  return [...stagedErrors, ...fileErrors].map((item) => item.message || "").filter(Boolean);
}

function isReadyStatus(fileStatus: string | null) {
  return !fileStatus || fileStatus === "READY";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function inferMailerMimeTypeFromFileName(fileName: string) {
  const extension = getMailAttachmentExtension(fileName);
  return extension ? MIME_BY_EXTENSION[extension] || null : null;
}

export function isSupportedMailerMimeType(mimeType: string) {
  return SUPPORTED_MIME_TYPES.has(
    String(mimeType || "")
      .trim()
      .toLowerCase(),
  );
}

function validateMailerAttachmentUploadInput(
  input: MailerAttachmentUploadInput,
  maxAttachmentBytes: number,
) {
  const normalizedMimeType = String(input.mimeType || "")
    .trim()
    .toLowerCase();

  if (!isSupportedMailerMimeType(normalizedMimeType)) {
    throw new Error("지원하지 않는 첨부파일 MIME 타입입니다.");
  }

  if (input.sizeBytes <= 0 || input.sizeBytes > maxAttachmentBytes) {
    throw new Error("첨부파일 크기가 허용 범위를 초과했습니다.");
  }

  if (!Buffer.isBuffer(input.data) || input.data.length !== input.sizeBytes) {
    throw new Error("업로드 파일 데이터가 올바르지 않습니다.");
  }

  return {
    ...input,
    mimeType: normalizedMimeType,
  };
}

function resolveMailerUploadKind(mimeType: string, fileName: string): MailerUploadKind | null {
  const normalizedMimeType = String(mimeType || "")
    .trim()
    .toLowerCase();
  const inferredMimeType = normalizedMimeType || inferMailerMimeTypeFromFileName(fileName);

  if (!inferredMimeType) {
    return null;
  }
  if (inferredMimeType.startsWith("image/")) {
    return "IMAGE";
  }
  if (inferredMimeType === "application/pdf") {
    return "FILE";
  }
  if (inferredMimeType.startsWith("video/")) {
    return "VIDEO";
  }
  return null;
}

function extractPreviewUrl(node: any) {
  return typeof node?.preview?.image?.url === "string" ? node.preview.image.url : null;
}

function extractFileNameFromUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const pathname = String(url.pathname || "");
    const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
    return lastSegment ? decodeURIComponent(lastSegment).trim() : null;
  } catch {
    return null;
  }
}

function resolveMailerShopifyFileName(node: any) {
  const explicitName = String(node?.filename || "").trim();
  if (explicitName) {
    return explicitName;
  }

  const candidates = [
    node?.url,
    node?.originalSource?.url,
    node?.image?.url,
    node?.originalSource?.url,
    Array.isArray(node?.sources) ? node.sources.find((item: any) => item?.url)?.url : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  for (const candidate of candidates) {
    const inferred = extractFileNameFromUrl(candidate);
    if (inferred) {
      return inferred;
    }
  }

  const idTail = String(node?.id || "")
    .split("/")
    .pop()
    ?.trim();
  return idTail ? `file-${idTail}` : null;
}

export function normalizeMailerShopifyFileNode(
  node: any,
  maxAttachmentBytes?: number,
): MailerShopifyFile | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const typename = String(node.__typename || "");
  const fileName = String(resolveMailerShopifyFileName(node) || "").trim();
  if (!fileName) {
    return null;
  }

  let fileUrl = "";
  let mimeType = "";
  let sizeBytes = Number(node.originalFileSize || 0);
  let contentType: MailerUploadKind | null = null;

  if (typename === "GenericFile") {
    fileUrl = String(node.url || "");
    mimeType = String(node.mimeType || inferMailerMimeTypeFromFileName(fileName) || "");
    contentType = "FILE";
  } else if (typename === "MediaImage") {
    fileUrl = String(node.image?.url || node.originalSource?.url || "");
    mimeType = String(node.mimeType || inferMailerMimeTypeFromFileName(fileName) || "");
    sizeBytes = Number(node.originalSource?.fileSize || node.originalFileSize || sizeBytes || 0);
    contentType = "IMAGE";
  } else if (typename === "Video") {
    const preferredSource = node.originalSource?.url
      ? node.originalSource
      : Array.isArray(node.sources)
        ? node.sources.find((item: any) => item?.url)
        : null;
    fileUrl = String(preferredSource?.url || "");
    mimeType = String(preferredSource?.mimeType || inferMailerMimeTypeFromFileName(fileName) || "");
    sizeBytes = Number(preferredSource?.fileSize || sizeBytes || 0);
    contentType = "VIDEO";
  } else {
    return null;
  }

  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (!fileUrl || !normalizedMimeType || !isSupportedMailerMimeType(normalizedMimeType)) {
    return null;
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null;
  }

  if (maxAttachmentBytes && sizeBytes > maxAttachmentBytes) {
    return null;
  }

  return {
    id: String(node.id || ""),
    shopifyFileId: String(node.id || ""),
    fileName,
    fileUrl,
    mimeType: normalizedMimeType,
    sizeBytes: Math.trunc(sizeBytes),
    previewUrl: extractPreviewUrl(node),
    fileStatus: node.fileStatus ? String(node.fileStatus) : null,
    contentType,
    createdAt: node.createdAt ? String(node.createdAt) : null,
  };
}

async function graphqlJson(
  adminClient: AdminApiContext,
  query: string,
  variables?: Record<string, unknown>,
) {
  const response = await adminClient.graphql(query, {
    variables,
  });

  if (!response.ok) {
    throw new Error(`Shopify Admin API 요청 실패 (status=${response.status})`);
  }

  const payload = await response.json();
  const graphqlErrors = getGraphqlErrors(payload);
  if (graphqlErrors.length > 0) {
    throw new Error(graphqlErrors.join(", "));
  }

  const userErrors = getUserErrors(payload);
  if (userErrors.length > 0) {
    throw new Error(userErrors.join(", "));
  }

  return payload;
}

async function createMailerStagedUploadTarget(
  adminClient: AdminApiContext,
  input: MailerAttachmentUploadInput,
  resource: MailerUploadKind,
) {
  const payload = await graphqlJson(adminClient, STAGED_UPLOAD_MUTATION, {
    input: [
      {
        resource,
        filename: input.filename,
        mimeType: input.mimeType,
        fileSize: String(input.sizeBytes),
      },
    ],
  });

  const target = payload?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new Error("Shopify staged upload target을 가져오지 못했습니다.");
  }

  return {
    url: String(target.url),
    resourceUrl: String(target.resourceUrl),
    parameters: Array.isArray(target.parameters)
      ? target.parameters
          .filter((item: any) => item?.name && item?.value != null)
          .map((item: any) => ({
            name: String(item.name),
            value: String(item.value),
          }))
      : [],
  };
}

function extractSignedHeaders(targetUrl: string): string[] | null {
  try {
    const url = new URL(targetUrl);
    for (const [key, value] of url.searchParams) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "x-goog-signedheaders" || normalizedKey === "x-amz-signedheaders") {
        return value
          .split(";")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);
      }
    }
  } catch {
    return null;
  }

  return null;
}

function shouldUsePut(urlHost: string, paramNames: string[]) {
  if (paramNames.length === 0) {
    return true;
  }

  const lowerNames = paramNames.map((item) => item.toLowerCase());
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

  return lowerNames.every(
    (name) =>
      name === "content_type" ||
      name === "content-type" ||
      name === "acl" ||
      name === "x-goog-meta-mimetype",
  );
}

function buildPutHeaders(
  urlHost: string,
  input: MailerAttachmentUploadInput,
  parameters: Array<{ name: string; value: string }>,
  signedHeaders: string[] | null,
) {
  const allowed = signedHeaders ? new Set(signedHeaders) : null;
  const allow = (name: string) => !allowed || allowed.has(name.toLowerCase());
  const headers: Record<string, string> = {};

  if (allow("content-type")) {
    headers["Content-Type"] = input.mimeType;
  }
  if (allow("content-length")) {
    headers["Content-Length"] = String(input.sizeBytes);
  }

  for (const parameter of parameters) {
    const normalizedName = parameter.name.toLowerCase();
    if (normalizedName === "content_type" || normalizedName === "content-type") {
      if (allow("content-type")) {
        headers["Content-Type"] = parameter.value;
      }
      continue;
    }

    if (normalizedName === "acl") {
      const headerName = urlHost.endsWith("storage.googleapis.com") ? "x-goog-acl" : "x-amz-acl";
      if (allow(headerName)) {
        headers[headerName] = parameter.value;
      }
      continue;
    }

    if (normalizedName.startsWith("x-goog-") || normalizedName.startsWith("x-amz-")) {
      if (allow(normalizedName)) {
        headers[parameter.name] = parameter.value;
      }
    }
  }

  return headers;
}

async function uploadMailerFileToStagedTarget(
  target: {
    url: string;
    resourceUrl: string;
    parameters: Array<{ name: string; value: string }>;
  },
  input: MailerAttachmentUploadInput,
) {
  const paramNames = target.parameters.map((item) => item.name);
  const urlHost = (() => {
    try {
      return new URL(target.url).host;
    } catch {
      return "";
    }
  })();
  const signedHeaders = extractSignedHeaders(target.url);

  if (shouldUsePut(urlHost, paramNames)) {
    const response = await fetch(target.url, {
      method: "PUT",
      headers: buildPutHeaders(urlHost, input, target.parameters, signedHeaders),
      body: input.data,
    });

    if (![200, 201, 204].includes(response.status)) {
      throw new Error(`staged upload 실패 (status=${response.status})`);
    }
    return;
  }

  const formData = new FormData();
  for (const parameter of target.parameters) {
    formData.append(parameter.name, parameter.value);
  }
  const blob = new Blob([input.data], { type: input.mimeType });
  formData.append("file", blob, input.filename);

  const response = await fetch(target.url, {
    method: "POST",
    body: formData,
  });

  if (![200, 201, 204].includes(response.status)) {
    throw new Error(`staged upload 실패 (status=${response.status})`);
  }
}

async function createMailerFileRecord(
  adminClient: AdminApiContext,
  resourceUrl: string,
  contentType: MailerUploadKind,
  alt?: string,
) {
  const payload = await graphqlJson(adminClient, FILE_CREATE_MUTATION, {
    files: [
      {
        originalSource: resourceUrl,
        contentType,
        alt,
      },
    ],
  });

  const fileId = payload?.data?.fileCreate?.files?.[0]?.id;
  if (!fileId) {
    throw new Error("Shopify fileCreate 결과에서 file id를 찾지 못했습니다.");
  }

  return String(fileId);
}

export async function listReusableMailerFiles(
  adminClient: AdminApiContext,
  params: {
    limit?: number;
    maxAttachmentBytes: number;
  },
) {
  const limit = Math.max(1, Math.min(params.limit || 10, 20));
  const payload = await graphqlJson(adminClient, FILES_QUERY, {
    first: Math.max(limit * 3, limit),
  });

  const nodes = Array.isArray(payload?.data?.files?.nodes) ? payload.data.files.nodes : [];

  return nodes
    .map((node: any) => normalizeMailerShopifyFileNode(node, params.maxAttachmentBytes))
    .filter((item): item is MailerShopifyFile => Boolean(item && isReadyStatus(item.fileStatus)))
    .slice(0, limit);
}

export async function getReusableMailerFileById(
  adminClient: AdminApiContext,
  id: string,
  maxAttachmentBytes: number,
) {
  const payload = await graphqlJson(adminClient, FILE_NODE_QUERY, { id });
  const item = normalizeMailerShopifyFileNode(payload?.data?.node, maxAttachmentBytes);

  if (!item || !isReadyStatus(item.fileStatus)) {
    return null;
  }

  return item;
}

async function waitForUploadedMailerFile(params: {
  adminClient: AdminApiContext;
  fileId: string;
  maxAttachmentBytes: number;
  attempts?: number;
  delayMs?: number;
}) {
  const attempts = params.attempts ?? 10;
  const delayMs = params.delayMs ?? 750;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const payload = await graphqlJson(params.adminClient, FILE_NODE_QUERY, {
      id: params.fileId,
    });
    const item = normalizeMailerShopifyFileNode(payload?.data?.node, params.maxAttachmentBytes);

    if (item && item.fileUrl && item.sizeBytes > 0) {
      return item;
    }

    await sleep(delayMs);
  }

  throw new Error(
    "Shopify Files 업로드는 완료됐지만 첨부 가능한 URL을 준비하지 못했습니다. 잠시 후 다시 시도하세요.",
  );
}

export async function uploadMailerAttachmentToShopifyFiles(
  adminClient: AdminApiContext,
  input: MailerAttachmentUploadInput,
  params: {
    maxAttachmentBytes: number;
  },
) {
  const validated = validateMailerAttachmentUploadInput(input, params.maxAttachmentBytes);
  const contentType = resolveMailerUploadKind(validated.mimeType, validated.filename);

  if (!contentType) {
    throw new Error("지원하지 않는 첨부파일 형식입니다.");
  }

  const stagedTarget = await createMailerStagedUploadTarget(adminClient, validated, contentType);
  await uploadMailerFileToStagedTarget(stagedTarget, validated);
  const fileId = await createMailerFileRecord(
    adminClient,
    stagedTarget.resourceUrl,
    contentType,
    validated.filename,
  );

  return waitForUploadedMailerFile({
    adminClient,
    fileId,
    maxAttachmentBytes: params.maxAttachmentBytes,
  });
}
