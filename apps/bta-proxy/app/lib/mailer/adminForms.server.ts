import { z } from "zod";
import { MAILER_ATTACHMENT_MODE_VALUES } from "~/lib/mailer/contracts";

export const mailTemplateEditorSchema = z.object({
  name: z.string().trim().min(1, "템플릿 이름은 필수입니다."),
  slug: z
    .string()
    .trim()
    .min(1, "템플릿 슬러그는 필수입니다.")
    .max(120, "템플릿 슬러그는 최대 120자까지 가능합니다.")
    .regex(/^[a-z0-9-]+$/, "슬러그는 소문자, 숫자, 하이픈만 사용할 수 있습니다."),
  subject: z.string().trim().min(1, "메일 제목은 필수입니다."),
  htmlBody: z.string().trim().min(1, "HTML 본문은 필수입니다."),
  textBody: z.string().trim().optional(),
  fromName: z.string().trim().optional(),
  replyTo: z.union([z.string().trim().email("reply-to 이메일 형식이 올바르지 않습니다."), z.literal("")]).optional(),
  attachmentMode: z.enum(MAILER_ATTACHMENT_MODE_VALUES),
  isActive: z.boolean(),
});

export const mailTemplateTestSendSchema = z.object({
  recipientEmail: z
    .string()
    .trim()
    .email("테스트 수신 이메일 형식이 올바르지 않습니다."),
  recipientName: z
    .string()
    .trim()
    .max(100, "테스트 수신자명은 최대 100자까지 가능합니다.")
    .optional(),
});

export const mailTemplateReuseAttachmentSchema = z.object({
  shopifyFileId: z.string().trim().min(1, "재사용할 Shopify 파일을 선택하세요."),
});

export const mailTemplateExternalAttachmentSchema = z.object({
  fileUrl: z.string().trim().url("외부 첨부파일 URL 형식이 올바르지 않습니다."),
  fileName: z
    .string()
    .trim()
    .max(255, "첨부파일명은 최대 255자까지 가능합니다.")
    .optional(),
});

export const mailTemplateAttachmentMutationSchema = z.object({
  attachmentId: z.string().trim().min(1, "첨부파일 식별자가 필요합니다."),
});

export const mailTemplateAttachmentMoveSchema = mailTemplateAttachmentMutationSchema.extend({
  direction: z.enum(["up", "down"], {
    errorMap: () => ({ message: "첨부파일 이동 방향이 올바르지 않습니다." }),
  }),
});

export type MailTemplateEditorInput = z.infer<typeof mailTemplateEditorSchema>;
export type MailTemplateTestSendInput = z.infer<typeof mailTemplateTestSendSchema>;
export type MailTemplateReuseAttachmentInput = z.infer<
  typeof mailTemplateReuseAttachmentSchema
>;
export type MailTemplateExternalAttachmentInput = z.infer<
  typeof mailTemplateExternalAttachmentSchema
>;
export type MailTemplateAttachmentMutationInput = z.infer<
  typeof mailTemplateAttachmentMutationSchema
>;
export type MailTemplateAttachmentMoveInput = z.infer<
  typeof mailTemplateAttachmentMoveSchema
>;

function getTrimmed(formData: FormData, name: string) {
  return String(formData.get(name) || "").trim();
}

export function parseMailTemplateEditorForm(formData: FormData) {
  return mailTemplateEditorSchema.parse({
    name: getTrimmed(formData, "name"),
    slug: getTrimmed(formData, "slug"),
    subject: getTrimmed(formData, "subject"),
    htmlBody: String(formData.get("htmlBody") || "").trim(),
    textBody: String(formData.get("textBody") || "").trim(),
    fromName: getTrimmed(formData, "fromName"),
    replyTo: getTrimmed(formData, "replyTo"),
    attachmentMode: getTrimmed(formData, "attachmentMode") || "NONE",
    isActive: formData.get("isActive") === "true",
  });
}

export function parseMailTemplateTestSendForm(formData: FormData) {
  return mailTemplateTestSendSchema.parse({
    recipientEmail: getTrimmed(formData, "recipientEmail"),
    recipientName: getTrimmed(formData, "recipientName"),
  });
}

export function parseMailTemplateReuseAttachmentForm(formData: FormData) {
  return mailTemplateReuseAttachmentSchema.parse({
    shopifyFileId: getTrimmed(formData, "shopifyFileId"),
  });
}

export function parseMailTemplateExternalAttachmentForm(formData: FormData) {
  return mailTemplateExternalAttachmentSchema.parse({
    fileUrl: getTrimmed(formData, "fileUrl"),
    fileName: getTrimmed(formData, "fileName"),
  });
}

export function parseMailTemplateAttachmentMutationForm(formData: FormData) {
  return mailTemplateAttachmentMutationSchema.parse({
    attachmentId: getTrimmed(formData, "attachmentId"),
  });
}

export function parseMailTemplateAttachmentMoveForm(formData: FormData) {
  return mailTemplateAttachmentMoveSchema.parse({
    attachmentId: getTrimmed(formData, "attachmentId"),
    direction: getTrimmed(formData, "direction"),
  });
}
