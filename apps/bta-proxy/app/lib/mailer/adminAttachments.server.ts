import type { MailTemplateAttachment } from "@prisma/client";
import type { MailAttachmentStorageType } from "~/lib/mailer/contracts";
import {
  inferMailerMimeTypeFromFileName,
  isSupportedMailerMimeType,
} from "~/lib/mailer/shopifyFiles.server";
import { isSupportedMailAttachmentFile } from "~/lib/mailer/storage";

export type MailerAttachmentPolicy = {
  maxAttachmentBytes: number;
  maxTemplateAttachmentCount: number;
  maxTotalAttachmentBytes: number;
};

export type MailerAttachmentCandidate = {
  storageType: MailAttachmentStorageType;
  shopifyFileId?: string | null;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
};

export type MailerAttachmentMoveDirection = "up" | "down";

function normalizeHttpUrl(rawUrl: string) {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("첨부파일 URL 형식이 올바르지 않습니다.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("첨부파일 URL은 http/https만 허용됩니다.");
  }

  return parsedUrl.toString();
}

function deriveAttachmentFileName(fileUrl: string, preferredFileName?: string | null) {
  const normalizedPreferred = String(preferredFileName || "").trim();
  if (normalizedPreferred) {
    return normalizedPreferred;
  }

  const parsedUrl = new URL(fileUrl);
  const pathSegment = parsedUrl.pathname.split("/").pop() || "";
  const derived = decodeURIComponent(pathSegment).trim();

  if (!derived) {
    throw new Error("첨부파일명을 확인할 수 없습니다.");
  }

  return derived;
}

export function buildNextTemplateAttachmentSortOrder(
  attachments: Pick<MailTemplateAttachment, "sortOrder">[]
) {
  if (attachments.length === 0) {
    return 0;
  }

  return Math.max(...attachments.map((item) => item.sortOrder)) + 1;
}

export function assertCanAppendTemplateAttachment(
  attachments: Pick<MailTemplateAttachment, "fileSizeBytes">[],
  candidateSizeBytes: number,
  policy: MailerAttachmentPolicy
) {
  if (!Number.isFinite(candidateSizeBytes) || candidateSizeBytes <= 0) {
    throw new Error("첨부파일 용량이 올바르지 않습니다.");
  }

  if (candidateSizeBytes > policy.maxAttachmentBytes) {
    throw new Error("첨부파일 허용 용량을 초과했습니다.");
  }

  if (attachments.length >= policy.maxTemplateAttachmentCount) {
    throw new Error("템플릿당 첨부파일 최대 개수를 초과했습니다.");
  }

  const totalAttachmentBytes =
    attachments.reduce((sum, item) => sum + item.fileSizeBytes, 0) + candidateSizeBytes;

  if (totalAttachmentBytes > policy.maxTotalAttachmentBytes) {
    throw new Error("템플릿 전체 첨부 용량 상한을 초과했습니다.");
  }
}

export function assertNoDuplicateTemplateAttachment(
  attachments: Pick<MailTemplateAttachment, "shopifyFileId" | "fileUrl">[],
  candidate: Pick<MailerAttachmentCandidate, "shopifyFileId" | "fileUrl">
) {
  if (
    candidate.shopifyFileId &&
    attachments.some((item) => item.shopifyFileId === candidate.shopifyFileId)
  ) {
    throw new Error("이미 연결된 Shopify 파일입니다.");
  }

  if (attachments.some((item) => item.fileUrl === candidate.fileUrl)) {
    throw new Error("이미 연결된 첨부파일 URL입니다.");
  }
}

export function buildMovedTemplateAttachmentIds(
  attachments: Pick<MailTemplateAttachment, "id">[],
  attachmentId: string,
  direction: MailerAttachmentMoveDirection
) {
  const orderedIds = attachments.map((item) => item.id);
  const currentIndex = orderedIds.indexOf(attachmentId);

  if (currentIndex < 0) {
    throw new Error("대상 첨부파일을 찾지 못했습니다.");
  }

  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= orderedIds.length) {
    return orderedIds;
  }

  const moved = [...orderedIds];
  const [item] = moved.splice(currentIndex, 1);
  moved.splice(targetIndex, 0, item);
  return moved;
}

export async function inspectExternalMailAttachment(params: {
  fileUrl: string;
  fileName?: string | null;
  maxAttachmentBytes: number;
  timeoutMs?: number;
}): Promise<MailerAttachmentCandidate> {
  const fileUrl = normalizeHttpUrl(params.fileUrl);
  const fileName = deriveAttachmentFileName(fileUrl, params.fileName);

  if (!isSupportedMailAttachmentFile(fileName)) {
    throw new Error("지원하지 않는 첨부파일 확장자입니다.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs ?? 10000);

  try {
    const response = await fetch(fileUrl, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`외부 첨부파일 다운로드에 실패했습니다 (${response.status}).`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new Error("첨부파일이 비어 있습니다.");
    }

    if (buffer.byteLength > params.maxAttachmentBytes) {
      throw new Error("첨부파일 허용 용량을 초과했습니다.");
    }

    const headerMimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
    const inferredMimeType = inferMailerMimeTypeFromFileName(fileName) || "";
    const mimeType = isSupportedMailerMimeType(headerMimeType)
      ? headerMimeType
      : inferredMimeType;

    if (!mimeType || !isSupportedMailerMimeType(mimeType)) {
      throw new Error("지원하지 않는 첨부파일 MIME 타입입니다.");
    }

    return {
      storageType: "EXTERNAL_URL",
      shopifyFileId: null,
      fileUrl,
      fileName,
      mimeType,
      fileSizeBytes: buffer.byteLength,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
