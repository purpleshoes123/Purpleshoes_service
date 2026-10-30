import {
  MAILER_ALLOWED_FILE_EXTENSIONS,
  MAILER_ATTACHMENT_STORAGE_TYPE_VALUES,
  type MailAttachmentStorageType,
} from "~/domains/mail/contracts";

export type MailAttachmentKind = keyof typeof MAILER_ALLOWED_FILE_EXTENSIONS;

const extensionKindMap = Object.entries(MAILER_ALLOWED_FILE_EXTENSIONS).reduce<
  Map<string, MailAttachmentKind>
>((map, [kind, extensions]) => {
  for (const extension of extensions) {
    map.set(extension, kind as MailAttachmentKind);
  }
  return map;
}, new Map<string, MailAttachmentKind>());

export function isMailAttachmentStorageType(value: string): value is MailAttachmentStorageType {
  return (MAILER_ATTACHMENT_STORAGE_TYPE_VALUES as readonly string[]).includes(value);
}

export function normalizeMailAttachmentStorageType(
  value?: string | null,
): MailAttachmentStorageType {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return isMailAttachmentStorageType(normalized)
    ? normalized
    : MAILER_ATTACHMENT_STORAGE_TYPE_VALUES[0];
}

export function getMailAttachmentExtension(fileName: string): string | null {
  const normalized = String(fileName || "").trim();
  const extension = normalized.includes(".")
    ? normalized.split(".").pop()?.toLowerCase() || null
    : null;
  return extension || null;
}

export function inferMailAttachmentKind(fileName: string): MailAttachmentKind | null {
  const extension = getMailAttachmentExtension(fileName);
  if (!extension) {
    return null;
  }
  return extensionKindMap.get(extension) || null;
}

export function isSupportedMailAttachmentFile(fileName: string) {
  return inferMailAttachmentKind(fileName) !== null;
}
