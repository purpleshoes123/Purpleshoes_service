const MB = 1024 * 1024;

export const MAILER_PROVIDER_KEYS = ["AWS_SES", "SMTP", "SENDGRID", "RESEND"] as const;
export type MailProviderKey = (typeof MAILER_PROVIDER_KEYS)[number];

export const DEFAULT_MAIL_PROVIDER: MailProviderKey = "AWS_SES";

export const MAILER_ATTACHMENT_MODE_VALUES = [
  "NONE",
  "ATTACH_FILES",
  "LINK_ONLY",
  "MIXED",
] as const;
export type MailAttachmentMode = (typeof MAILER_ATTACHMENT_MODE_VALUES)[number];

export const MAILER_ATTACHMENT_STORAGE_TYPE_VALUES = [
  "SHOPIFY_FILE",
  "EXTERNAL_URL",
  "APP_STORAGE",
] as const;
export type MailAttachmentStorageType = (typeof MAILER_ATTACHMENT_STORAGE_TYPE_VALUES)[number];

export const MAILER_REQUEST_SOURCE_VALUES = [
  "STOREFRONT_PAGE",
  "ADMIN_TEST",
  "INTERNAL_TRIGGER",
] as const;
export type MailRequestSource = (typeof MAILER_REQUEST_SOURCE_VALUES)[number];

export const MAILER_RATE_LIMIT_TARGET_VALUES = ["EMAIL", "IP", "TEMPLATE", "PAGE"] as const;
export type MailRateLimitTargetType = (typeof MAILER_RATE_LIMIT_TARGET_VALUES)[number];

export const MAILER_SEND_STATUS_VALUES = ["PENDING", "SENT", "FAILED", "BLOCKED"] as const;
export type MailSendStatus = (typeof MAILER_SEND_STATUS_VALUES)[number];

export const MAILER_ERROR_CODE_VALUES = [
  "MAILER_INVALID_INPUT",
  "MAILER_NOT_CONFIGURED",
  "MAILER_RECAPTCHA_FAILED",
  "MAILER_RECIPIENT_UNSUBSCRIBED",
  "MAILER_RATE_LIMITED",
  "MAILER_TEMPLATE_NOT_FOUND",
  "MAILER_TEMPLATE_INACTIVE",
  "MAILER_ATTACHMENT_INVALID",
  "MAILER_PROVIDER_ERROR",
  "MAILER_PROVIDER_TIMEOUT",
] as const;
export type MailerErrorCode = (typeof MAILER_ERROR_CODE_VALUES)[number];

export const MAILER_ALLOWED_FILE_EXTENSIONS = {
  pdf: ["pdf"],
  image: ["jpg", "jpeg", "png", "webp"],
  video: ["mp4", "mov", "webm"],
} as const;

export const MAILER_TEMPLATE_VARIABLES = [
  "{{ shop.name }}",
  "{{ recipient.email }}",
  "{{ page.path }}",
  "{{ sent_at }}",
  "{{ starter_kit.viewer_url }}",
  "{{ unsubscribe_url }}",
] as const;

export const MAILER_DEFAULT_RECAPTCHA_ACTION = "mail_request_submit";
export const MAILER_DEFAULT_RECAPTCHA_THRESHOLD = 0.5;
export const MAILER_DEFAULT_LOG_RETENTION_DAYS = 180;

export const MAILER_MAX_ATTACHMENT_BYTES = 10 * MB;
export const MAILER_DEFAULT_TEMPLATE_ATTACHMENT_LIMIT = 5;
export const MAILER_DEFAULT_TOTAL_ATTACHMENT_BYTES = 25 * MB;

export const MAILER_DEFAULT_RATE_LIMITS = {
  emailPer10Min: 3,
  ipPer10Min: 10,
  templatePerHour: 100,
} as const;

export const MAILER_ROUTE_PATHS = {
  storefrontAlias: "/apps/bta-booking/mail/request",
  proxyRequest: "/proxy/bta/mail/request",
  adminRoot: "/app/mail",
  adminTemplates: "/app/mail/templates",
  adminTemplateNew: "/app/mail/templates/new",
  adminTemplateDetail(templateId: string) {
    return `/app/mail/templates/${encodeURIComponent(templateId)}`;
  },
  adminLogs: "/app/mail/logs",
  adminLogDetail(logId: string) {
    return `/app/mail/logs/${encodeURIComponent(logId)}`;
  },
  adminSettings: "/app/mail/settings",
} as const;
