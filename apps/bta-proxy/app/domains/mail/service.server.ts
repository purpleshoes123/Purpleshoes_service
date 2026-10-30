import { createHash } from "crypto";
import { Prisma, type MailTemplateAttachment } from "@prisma/client";
import db from "~/db.server.ts";
import { ErrorCode } from "~/lib/errors";
import { getMailerEnv, getMissingProviderConfigKeys } from "~/domains/mail/env";
import { getMailProviderRuntimeIssue, MailProviderTimeoutError } from "~/domains/mail/provider";
import {
  createSendRequest,
  createSendRequestAttachment,
  deleteSendRequestAttachments,
  getLatestSendRequestByRequestKey,
  getSendRequestDetail,
  markSendRequestFailed,
  markSendRequestSent,
  updateSendRequest,
} from "~/domains/mail/sendRequestStore.server.ts";
import {
  getMailRateLimitCounter,
  registerMailRateLimitAttempt,
} from "~/domains/mail/rateLimitStore.server.ts";
import { renderMailTemplate } from "~/domains/mail/render.server.ts";
import { sendMailWithConfiguredProvider } from "~/domains/mail/provider.server.ts";
import { verifyRecaptchaToken } from "~/domains/mail/recaptcha.server.ts";
import { inferMailAttachmentKind, isSupportedMailAttachmentFile } from "~/domains/mail/storage";
import {
  getTemplateById,
  getTemplateBySlug,
  listTemplateAttachments,
} from "~/domains/mail/templateStore.server.ts";
import {
  sendKlaviyoMailEventForSentMail,
  type KlaviyoMailEventInput,
} from "~/domains/mail/klaviyoEvent.server.ts";
import type { MailerDbClient } from "~/domains/mail/store.shared.ts";
import {
  createMailUnsubscribeUrl,
  isMailRecipientUnsubscribed,
} from "~/domains/mail/unsubscribe.server.ts";
import type { StorefrontMailRequestInput } from "~/lib/validation";
import { claimRegistrationDelivery } from "./registration-once.server.ts";

type SubmitStorefrontMailRequestParams = {
  shopDomain: string;
  input: StorefrontMailRequestInput;
  request: Request;
  prisma?: MailerDbClient;
};

type SubmitStorefrontMailRequestResult = {
  requestId: string;
  duplicate: boolean;
  sentAt: string;
};

type SendRequestDeliveryResult = {
  requestId: string;
  sentAt: string;
};

type SendAdminTemplateTestMailParams = {
  shopDomain: string;
  templateId: string;
  recipientEmail: string;
  recipientName?: string | null;
  prisma?: MailerDbClient;
};

type SendCustomerRegistrationMailParams = {
  registrationSource: "verified-web-session";
  shopDomain: string;
  customerId: string;
  recipientEmail: string;
  recipientName?: string | null;
  prisma?: MailerDbClient;
};

type SendCustomerRegistrationMailResult = SendRequestDeliveryResult & {
  templateSlug: "register-no-squeeze";
  hadSqueezeMail: boolean;
  skippedDueToSqueeze: false;
};

type ResendFailedMailRequestParams = {
  shopDomain: string;
  sendRequestId: string;
  prisma?: MailerDbClient;
};

type ResolvedAttachment = {
  templateAttachmentId: string | null;
  resolvedFileUrl: string;
  resolvedFileName: string;
  resolvedMimeType: string;
  resolvedFileSizeBytes: number;
  contentBase64?: string;
};

type AttachmentResolutionSource = {
  id: string | null;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
};

function isRequestKeyCreateConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function hasMatchingRequestKeyPayload(params: {
  existingTemplateId: string;
  existingRecipientEmail: string;
  nextTemplateId: string;
  nextRecipientEmail: string;
}) {
  return (
    params.existingTemplateId === params.nextTemplateId &&
    params.existingRecipientEmail === params.nextRecipientEmail
  );
}

async function reconcileExistingStorefrontRequestKey(params: {
  prisma: MailerDbClient;
  existingRequest: Awaited<ReturnType<typeof getLatestSendRequestByRequestKey>>;
  templateId: string;
  recipientEmail: string;
  recipientName?: string | null;
  request: Request;
  pagePath?: string | null;
  ipHash?: string | null;
  emailProvider: ReturnType<typeof assertMailerRuntimeConfigured>["provider"];
  recaptchaAction: string;
}) {
  const existing = params.existingRequest;
  if (!existing) {
    return null;
  }

  if (
    !hasMatchingRequestKeyPayload({
      existingTemplateId: existing.templateId,
      existingRecipientEmail: existing.recipientEmail,
      nextTemplateId: params.templateId,
      nextRecipientEmail: params.recipientEmail,
    })
  ) {
    throw new MailerServiceError(ErrorCode.INTERNAL_CONFLICT);
  }

  if (existing.status === "SENT") {
    return {
      kind: "duplicate" as const,
      requestId: existing.id,
      sentAt: existing.sentAt?.toISOString() || existing.createdAt.toISOString(),
    };
  }

  if (existing.status === "PENDING") {
    throw new MailerServiceError(ErrorCode.INTERNAL_CONFLICT);
  }

  await deleteSendRequestAttachments(params.prisma, existing.id);
  const sendRequest = await updateSendRequest(params.prisma, {
    id: existing.id,
    recipientName: params.recipientName,
    recaptchaAction: params.recaptchaAction,
    recaptchaScore: null,
    recaptchaSuccess: null,
    status: "PENDING",
    failureCode: null,
    failureReason: null,
    emailProvider: params.emailProvider,
    providerMessageId: null,
    userAgent: params.request.headers.get("user-agent"),
    ipHash: params.ipHash || null,
    pagePath: params.pagePath || null,
    templateNameSnapshot: null,
    templateSlugSnapshot: null,
    attachmentModeSnapshot: null,
    subjectSnapshot: null,
    htmlBodySnapshot: null,
    textBodySnapshot: null,
    fromNameSnapshot: null,
    replyToSnapshot: null,
    sentAt: null,
  });

  return {
    kind: "retry" as const,
    sendRequest,
  };
}

type ResolvedBinaryAttachment = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
};

type ResolvedAttachmentSet = {
  links: Array<{
    fileName: string;
    fileUrl: string;
  }>;
  resolvedForLog: ResolvedAttachment[];
  resolvedForMail: ResolvedBinaryAttachment[];
  includeAttachmentLinks: boolean;
};

type MailSendRequestSnapshot = {
  templateNameSnapshot: string | null;
  templateSlugSnapshot: string | null;
  attachmentModeSnapshot: string;
  subjectSnapshot: string;
  htmlBodySnapshot: string;
  textBodySnapshot: string;
  fromNameSnapshot: string | null;
  replyToSnapshot: string | null;
};

type MailEventContext = Pick<
  KlaviyoMailEventInput,
  "shopDomain" | "requestSource" | "pagePath" | "customerId"
>;

const DEFAULT_STARTER_KIT_VIEWER_URL = "https://kpurpleshoes.com/pages/starter-kit-viewer";

function isSqueezeTemplate(templateSlug: string) {
  return templateSlug.trim().toLowerCase() === "squeeze";
}

function getStarterKitViewerUrl() {
  const configuredUrl = process.env.STARTER_KIT_VIEWER_URL?.trim();

  if (!configuredUrl) {
    return DEFAULT_STARTER_KIT_VIEWER_URL;
  }

  try {
    const url = new URL(configuredUrl);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.toString();
    }
  } catch {
    // Use the known public Viewer address when an environment value is invalid.
  }

  return DEFAULT_STARTER_KIT_VIEWER_URL;
}

function addStarterKitViewerLink(params: {
  rendered: ReturnType<typeof renderMailTemplate>;
  templateSlug: string;
}) {
  if (!isSqueezeTemplate(params.templateSlug)) {
    return params.rendered;
  }

  const viewerUrl = getStarterKitViewerUrl();
  if (
    params.rendered.htmlBody.includes(viewerUrl) ||
    params.rendered.textBody.includes(viewerUrl)
  ) {
    return params.rendered;
  }

  return {
    ...params.rendered,
    htmlBody: `${params.rendered.htmlBody}<p><a href="${viewerUrl}">Open your free Starter Kit Viewer</a></p>`,
    textBody:
      `${params.rendered.textBody}\n\nOpen your free Starter Kit Viewer: ${viewerUrl}`.trim(),
  };
}

/**
 * Registration thank-you emails are transactional lifecycle messages. They
 * must not re-enter a lead into the squeeze (five-day sign-up reminder)
 * flow, even when the generic Klaviyo mail-event allowlist is configured as
 * `*` in production.
 */
export function shouldSyncKlaviyoMailEventForTemplate(templateSlug: string | null | undefined) {
  const normalizedSlug = String(templateSlug || "")
    .trim()
    .toLowerCase();
  return normalizedSlug !== "register" && normalizedSlug !== "register-no-squeeze";
}

export class MailerServiceError extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MailerServiceError";
    this.code = code;
    this.details = details;
  }
}

function getClientIp(request: Request) {
  const headers = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("fly-client-ip"),
    request.headers.get("x-real-ip"),
    request.headers.get("x-forwarded-for"),
  ];

  for (const raw of headers) {
    if (!raw) {
      continue;
    }
    const ip = raw.split(",")[0]?.trim();
    if (ip) {
      return ip;
    }
  }

  return null;
}

function hashValue(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertMailerRuntimeConfigured() {
  const env = getMailerEnv();
  const missing: string[] = [];

  if (!env.fromEmail) {
    missing.push("MAIL_FROM_EMAIL");
  }
  if (!env.recaptchaSecretKey) {
    missing.push("MAIL_RECAPTCHA_SECRET_KEY");
  }

  for (const key of getMissingProviderConfigKeys(env)) {
    if (!missing.includes(key)) {
      missing.push(key);
    }
  }

  const runtimeIssue = getMailProviderRuntimeIssue(env.provider);
  if (runtimeIssue) {
    missing.push(runtimeIssue);
  }

  if (missing.length > 0) {
    throw new MailerServiceError(ErrorCode.MAILER_NOT_CONFIGURED, undefined, {
      missing,
    });
  }

  return env;
}

async function getTemplateForShopById(
  prisma: MailerDbClient,
  params: {
    shopDomain: string;
    templateId: string;
    includeDeleted?: boolean;
  },
) {
  const template = await getTemplateById(prisma, params.templateId, {
    includeDeleted: params.includeDeleted,
  });

  if (!template || template.shopDomain !== params.shopDomain) {
    throw new MailerServiceError(ErrorCode.MAILER_TEMPLATE_NOT_FOUND);
  }

  return template;
}

async function fetchAttachmentBinary(
  attachment: Pick<AttachmentResolutionSource, "fileUrl" | "mimeType">,
  maxAttachmentBytes: number,
) {
  const parsedUrl = validateAttachmentUrl(attachment.fileUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(parsedUrl, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        `첨부파일 다운로드에 실패했습니다 (${response.status}).`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.byteLength === 0) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        "첨부파일이 비어 있습니다.",
      );
    }

    if (buffer.byteLength > maxAttachmentBytes) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        "첨부파일 허용 용량을 초과했습니다.",
      );
    }

    return {
      mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || attachment.mimeType,
      sizeBytes: buffer.byteLength,
      contentBase64: buffer.toString("base64"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function validateAttachmentUrl(fileUrl: string) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fileUrl);
  } catch {
    throw new MailerServiceError(
      ErrorCode.MAILER_ATTACHMENT_INVALID,
      "첨부파일 URL이 올바르지 않습니다.",
    );
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new MailerServiceError(
      ErrorCode.MAILER_ATTACHMENT_INVALID,
      "첨부파일 URL 스킴이 올바르지 않습니다.",
    );
  }

  return parsedUrl;
}

async function resolveAttachmentSources(params: {
  attachments: AttachmentResolutionSource[];
  attachmentMode: string;
  maxAttachmentBytes: number;
  maxTemplateAttachmentCount: number;
  maxTotalAttachmentBytes: number;
}): Promise<ResolvedAttachmentSet> {
  const normalizedMode = String(params.attachmentMode || "NONE").toUpperCase();

  if (
    params.attachments.length > 0 &&
    params.attachments.length > params.maxTemplateAttachmentCount
  ) {
    throw new MailerServiceError(
      ErrorCode.MAILER_ATTACHMENT_INVALID,
      "템플릿 첨부파일 개수가 허용 한도를 초과했습니다.",
    );
  }

  if (normalizedMode === "NONE" || params.attachments.length === 0) {
    return {
      links: [],
      resolvedForLog: [] as ResolvedAttachment[],
      resolvedForMail: [] as ResolvedBinaryAttachment[],
      includeAttachmentLinks: false,
    };
  }

  const resolvedForLog: ResolvedAttachment[] = [];
  const resolvedForMail: ResolvedBinaryAttachment[] = [];
  const links = params.attachments.map((attachment) => ({
    fileName: attachment.fileName,
    fileUrl: attachment.fileUrl,
  }));

  let totalAttachmentBytes = 0;

  for (const attachment of params.attachments) {
    validateAttachmentUrl(attachment.fileUrl);

    if (!isSupportedMailAttachmentFile(attachment.fileName)) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        "지원하지 않는 첨부파일 형식입니다.",
      );
    }

    if (attachment.fileSizeBytes <= 0) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        "첨부파일 용량이 올바르지 않습니다.",
      );
    }

    if (attachment.fileSizeBytes > params.maxAttachmentBytes) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        "첨부파일 허용 용량을 초과했습니다.",
      );
    }

    const kind = inferMailAttachmentKind(attachment.fileName);
    if (!kind) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        "지원하지 않는 첨부파일 확장자입니다.",
      );
    }

    if (normalizedMode === "LINK_ONLY") {
      resolvedForLog.push({
        templateAttachmentId: attachment.id,
        resolvedFileUrl: attachment.fileUrl,
        resolvedFileName: attachment.fileName,
        resolvedMimeType: attachment.mimeType,
        resolvedFileSizeBytes: attachment.fileSizeBytes,
      });
      continue;
    }

    const binary = await fetchAttachmentBinary(attachment, params.maxAttachmentBytes);
    totalAttachmentBytes += binary.sizeBytes;

    if (totalAttachmentBytes > params.maxTotalAttachmentBytes) {
      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        "전체 첨부파일 허용 용량을 초과했습니다.",
      );
    }

    resolvedForLog.push({
      templateAttachmentId: attachment.id,
      resolvedFileUrl: attachment.fileUrl,
      resolvedFileName: attachment.fileName,
      resolvedMimeType: binary.mimeType,
      resolvedFileSizeBytes: binary.sizeBytes,
      contentBase64: binary.contentBase64,
    });
    resolvedForMail.push({
      fileName: attachment.fileName,
      mimeType: binary.mimeType,
      sizeBytes: binary.sizeBytes,
      contentBase64: binary.contentBase64,
    });
  }

  return {
    links,
    resolvedForLog,
    resolvedForMail,
    includeAttachmentLinks: normalizedMode === "LINK_ONLY" || normalizedMode === "MIXED",
  };
}

async function resolveTemplateAttachments(params: {
  attachments: MailTemplateAttachment[];
  attachmentMode: string;
  maxAttachmentBytes: number;
  maxTemplateAttachmentCount: number;
  maxTotalAttachmentBytes: number;
}) {
  return resolveAttachmentSources({
    ...params,
    attachments: params.attachments.map((attachment) => ({
      id: attachment.id,
      fileUrl: attachment.fileUrl,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSizeBytes: attachment.fileSizeBytes,
    })),
  });
}

async function resolveHistoricalSendRequestAttachments(params: {
  attachments: Array<{
    id: string;
    templateAttachmentId: string | null;
    resolvedFileUrl: string;
    resolvedFileName: string;
    resolvedMimeType: string;
    resolvedFileSizeBytes: number;
  }>;
  attachmentMode: string;
  maxAttachmentBytes: number;
  maxTemplateAttachmentCount: number;
  maxTotalAttachmentBytes: number;
}) {
  return resolveAttachmentSources({
    attachmentMode: params.attachmentMode,
    maxAttachmentBytes: params.maxAttachmentBytes,
    maxTemplateAttachmentCount: params.maxTemplateAttachmentCount,
    maxTotalAttachmentBytes: params.maxTotalAttachmentBytes,
    attachments: params.attachments.map((attachment) => ({
      id: attachment.templateAttachmentId,
      fileUrl: attachment.resolvedFileUrl,
      fileName: attachment.resolvedFileName,
      mimeType: attachment.resolvedMimeType,
      fileSizeBytes: attachment.resolvedFileSizeBytes,
    })),
  });
}

async function persistSendRequestSnapshot(
  prisma: MailerDbClient,
  sendRequestId: string,
  snapshot: MailSendRequestSnapshot,
) {
  await updateSendRequest(prisma, {
    id: sendRequestId,
    templateNameSnapshot: snapshot.templateNameSnapshot,
    templateSlugSnapshot: snapshot.templateSlugSnapshot,
    attachmentModeSnapshot: snapshot.attachmentModeSnapshot,
    subjectSnapshot: snapshot.subjectSnapshot,
    htmlBodySnapshot: snapshot.htmlBodySnapshot,
    textBodySnapshot: snapshot.textBodySnapshot,
    fromNameSnapshot: snapshot.fromNameSnapshot,
    replyToSnapshot: snapshot.replyToSnapshot,
  });
}

async function recordResolvedAttachments(
  prisma: MailerDbClient,
  sendRequestId: string,
  attachments: ResolvedAttachment[],
) {
  for (const attachment of attachments) {
    await createSendRequestAttachment(prisma, {
      sendRequestId,
      templateAttachmentId: attachment.templateAttachmentId,
      resolvedFileUrl: attachment.resolvedFileUrl,
      resolvedFileName: attachment.resolvedFileName,
      resolvedMimeType: attachment.resolvedMimeType,
      resolvedFileSizeBytes: attachment.resolvedFileSizeBytes,
    });
  }
}

async function sendPreparedMailForSendRequest(params: {
  prisma: MailerDbClient;
  env: ReturnType<typeof assertMailerRuntimeConfigured>;
  sendRequestId: string;
  recipientEmail: string;
  recipientName?: string | null;
  snapshot: MailSendRequestSnapshot;
  resolvedAttachments: ResolvedAttachmentSet;
  mailEventContext: MailEventContext;
}) {
  await persistSendRequestSnapshot(params.prisma, params.sendRequestId, params.snapshot);
  await recordResolvedAttachments(
    params.prisma,
    params.sendRequestId,
    params.resolvedAttachments.resolvedForLog,
  );

  try {
    const providerResult = await sendMailWithConfiguredProvider({
      from: {
        email: params.env.fromEmail!,
        name: params.snapshot.fromNameSnapshot || params.env.fromName || null,
      },
      recipient: {
        email: params.recipientEmail,
        name: params.recipientName || null,
      },
      subject: params.snapshot.subjectSnapshot,
      htmlBody: params.snapshot.htmlBodySnapshot,
      textBody: params.snapshot.textBodySnapshot,
      replyTo: params.snapshot.replyToSnapshot || params.env.replyToEmail || null,
      attachments: params.resolvedAttachments.resolvedForMail,
    });

    await markSendRequestSent(params.prisma, {
      id: params.sendRequestId,
      providerMessageId: providerResult.messageId,
      sentAt: providerResult.acceptedAt,
    });

    if (shouldSyncKlaviyoMailEventForTemplate(params.snapshot.templateSlugSnapshot)) {
      await sendKlaviyoMailEventForSentMail({
        env: params.env,
        input: {
          sendRequestId: params.sendRequestId,
          shopDomain: params.mailEventContext.shopDomain,
          templateSlug: params.snapshot.templateSlugSnapshot,
          templateName: params.snapshot.templateNameSnapshot,
          recipientEmail: params.recipientEmail,
          recipientName: params.recipientName || null,
          customerId: params.mailEventContext.customerId || null,
          requestSource: params.mailEventContext.requestSource,
          emailProvider: params.env.provider,
          providerMessageId: providerResult.messageId,
          sentAt: providerResult.acceptedAt,
          pagePath: params.mailEventContext.pagePath || null,
        },
      });
    }

    return {
      requestId: params.sendRequestId,
      sentAt: providerResult.acceptedAt,
    };
  } catch (error) {
    const failureCode =
      error instanceof MailProviderTimeoutError ||
      (error instanceof Error && error.message.toLowerCase().includes("timeout"))
        ? ErrorCode.MAILER_PROVIDER_TIMEOUT
        : error instanceof Error && error.name === "MailProviderNotImplementedError"
          ? ErrorCode.MAILER_NOT_CONFIGURED
          : ErrorCode.MAILER_PROVIDER_ERROR;

    await markSendRequestFailed(params.prisma, {
      id: params.sendRequestId,
      status: "FAILED",
      failureCode,
      failureReason: error instanceof Error ? error.message : String(error),
    });

    throw new MailerServiceError(
      failureCode,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function hasHistoricalSnapshot(
  request: Awaited<ReturnType<typeof getSendRequestDetail>>,
): request is NonNullable<Awaited<ReturnType<typeof getSendRequestDetail>>> & {
  subjectSnapshot: string;
  htmlBodySnapshot: string;
  attachmentModeSnapshot: string;
} {
  return Boolean(
    request &&
    request.subjectSnapshot &&
    request.htmlBodySnapshot &&
    request.attachmentModeSnapshot,
  );
}

async function registerStorefrontRateLimitAttempt(params: {
  prisma: MailerDbClient;
  shopDomain: string;
  recipientEmail: string;
  ipHash: string | null;
  templateId: string;
  pagePath: string | null;
}) {
  const env = getMailerEnv();
  const blockedTargets: string[] = [];
  const normalizedEmail = params.recipientEmail.trim().toLowerCase();

  const [emailCounter, ipCounter] = await Promise.all([
    getMailRateLimitCounter(params.prisma, {
      shopDomain: params.shopDomain,
      targetType: "EMAIL",
      targetKey: normalizedEmail,
      windowMs: 10 * 60 * 1000,
    }),
    params.ipHash
      ? getMailRateLimitCounter(params.prisma, {
          shopDomain: params.shopDomain,
          targetType: "IP",
          targetKey: params.ipHash,
          windowMs: 10 * 60 * 1000,
        })
      : Promise.resolve(null),
  ]);

  if (emailCounter && emailCounter.requestCount >= env.emailRateLimitPer10Min) {
    blockedTargets.push("EMAIL");
  }

  if (params.ipHash && ipCounter && ipCounter.requestCount >= env.ipRateLimitPer10Min) {
    blockedTargets.push("IP");
  }

  const isBlocked = blockedTargets.length > 0;
  const tasks = [
    registerMailRateLimitAttempt(params.prisma, {
      shopDomain: params.shopDomain,
      targetType: "EMAIL",
      targetKey: normalizedEmail,
      windowMs: 10 * 60 * 1000,
      blocked: blockedTargets.includes("EMAIL"),
    }),
    registerMailRateLimitAttempt(params.prisma, {
      shopDomain: params.shopDomain,
      targetType: "TEMPLATE",
      targetKey: params.templateId,
      windowMs: 60 * 60 * 1000,
      blocked: false,
    }),
  ];

  if (params.ipHash) {
    tasks.push(
      registerMailRateLimitAttempt(params.prisma, {
        shopDomain: params.shopDomain,
        targetType: "IP",
        targetKey: params.ipHash,
        windowMs: 10 * 60 * 1000,
        blocked: blockedTargets.includes("IP"),
      }),
    );
  }

  if (params.pagePath) {
    tasks.push(
      registerMailRateLimitAttempt(params.prisma, {
        shopDomain: params.shopDomain,
        targetType: "PAGE",
        targetKey: params.pagePath,
        windowMs: 10 * 60 * 1000,
        blocked: false,
      }),
    );
  }

  await Promise.all(tasks);

  return {
    blocked: isBlocked,
    blockedTargets,
  };
}

async function deliverMailForSendRequest(params: {
  prisma: MailerDbClient;
  template: Awaited<ReturnType<typeof getTemplateById>> extends infer T ? NonNullable<T> : never;
  sendRequestId: string;
  recipientEmail: string;
  recipientName?: string | null;
  shopDomain: string;
  shopName: string;
  pagePath?: string | null;
  requestSource: string;
  customerId?: string | null;
  allowInactive?: boolean;
}): Promise<SendRequestDeliveryResult> {
  const env = assertMailerRuntimeConfigured();

  if (
    await isMailRecipientUnsubscribed(params.prisma, {
      shopDomain: params.shopDomain,
      recipientEmail: params.recipientEmail,
    })
  ) {
    await markSendRequestFailed(params.prisma, {
      id: params.sendRequestId,
      status: "BLOCKED",
      failureCode: ErrorCode.MAILER_RECIPIENT_UNSUBSCRIBED,
      failureReason: "Recipient opted out of BTA mail.",
    });
    throw new MailerServiceError(ErrorCode.MAILER_RECIPIENT_UNSUBSCRIBED);
  }

  if (!params.allowInactive && !params.template.isActive) {
    await markSendRequestFailed(params.prisma, {
      id: params.sendRequestId,
      status: "BLOCKED",
      failureCode: ErrorCode.MAILER_TEMPLATE_INACTIVE,
      failureReason: "Template is inactive.",
    });
    throw new MailerServiceError(ErrorCode.MAILER_TEMPLATE_INACTIVE);
  }

  const squeezeTemplate = isSqueezeTemplate(params.template.slug);
  let resolvedAttachments: ResolvedAttachmentSet = {
    links: [],
    resolvedForLog: [],
    resolvedForMail: [],
    includeAttachmentLinks: false,
  };

  if (!squeezeTemplate) {
    try {
      const templateAttachments = await listTemplateAttachments(params.prisma, params.template.id);
      resolvedAttachments = await resolveTemplateAttachments({
        attachments: templateAttachments,
        attachmentMode: params.template.attachmentMode,
        maxAttachmentBytes: env.maxAttachmentBytes,
        maxTemplateAttachmentCount: env.maxTemplateAttachmentCount,
        maxTotalAttachmentBytes: env.maxTotalAttachmentBytes,
      });
    } catch (error) {
      const failureCode =
        error instanceof MailerServiceError ? error.code : ErrorCode.MAILER_ATTACHMENT_INVALID;

      await markSendRequestFailed(params.prisma, {
        id: params.sendRequestId,
        status: "FAILED",
        failureCode,
        failureReason: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof MailerServiceError) {
        throw error;
      }

      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const sentAt = new Date().toISOString();
  const rendered = addStarterKitViewerLink({
    templateSlug: params.template.slug,
    rendered: renderMailTemplate({
      subject: params.template.subject,
      htmlBody: params.template.htmlBody,
      textBody: params.template.textBody,
      variables: {
        shopName: params.shopName,
        recipientEmail: params.recipientEmail,
        pagePath: params.pagePath || "",
        sentAt,
        starterKitViewerUrl: getStarterKitViewerUrl(),
        unsubscribeUrl: createMailUnsubscribeUrl({
          shopDomain: params.shopDomain,
          sendRequestId: params.sendRequestId,
        }),
      },
      attachmentLinks: resolvedAttachments.links,
      includeAttachmentLinks: resolvedAttachments.includeAttachmentLinks,
    }),
  });

  return sendPreparedMailForSendRequest({
    prisma: params.prisma,
    env,
    sendRequestId: params.sendRequestId,
    recipientEmail: params.recipientEmail,
    recipientName: params.recipientName,
    snapshot: {
      templateNameSnapshot: params.template.name,
      templateSlugSnapshot: params.template.slug,
      attachmentModeSnapshot: squeezeTemplate ? "NONE" : params.template.attachmentMode,
      subjectSnapshot: rendered.subject,
      htmlBodySnapshot: rendered.htmlBody,
      textBodySnapshot: rendered.textBody,
      fromNameSnapshot: params.template.fromName || env.fromName || null,
      replyToSnapshot: params.template.replyTo || env.replyToEmail || null,
    },
    resolvedAttachments,
    mailEventContext: {
      shopDomain: params.shopDomain,
      requestSource: params.requestSource,
      pagePath: params.pagePath || null,
      customerId: params.customerId || null,
    },
  });
}

export async function submitStorefrontMailRequest(
  params: SubmitStorefrontMailRequestParams,
): Promise<SubmitStorefrontMailRequestResult> {
  const prisma = params.prisma || db;
  const env = assertMailerRuntimeConfigured();
  const template = await getTemplateBySlug(prisma, {
    shopDomain: params.shopDomain,
    slug: params.input.templateSlug,
    activeOnly: false,
  });

  if (!template) {
    throw new MailerServiceError(ErrorCode.MAILER_TEMPLATE_NOT_FOUND);
  }

  const clientIp = getClientIp(params.request);
  const ipHash = clientIp ? hashValue(clientIp) : null;

  let sendRequest: Awaited<ReturnType<typeof createSendRequest>>;
  if (params.input.requestKey) {
    const existing = await getLatestSendRequestByRequestKey(prisma, {
      shopDomain: params.shopDomain,
      requestKey: params.input.requestKey,
    });

    const reconciled = await reconcileExistingStorefrontRequestKey({
      prisma,
      existingRequest: existing,
      templateId: template.id,
      recipientEmail: params.input.email,
      recipientName: params.input.name,
      request: params.request,
      pagePath: params.input.pagePath,
      ipHash,
      emailProvider: env.provider,
      recaptchaAction: env.recaptchaAction,
    });

    if (reconciled?.kind === "duplicate") {
      return {
        requestId: reconciled.requestId,
        duplicate: true,
        sentAt: reconciled.sentAt,
      };
    }

    if (reconciled?.kind === "retry") {
      sendRequest = reconciled.sendRequest;
    }
  }

  if (!sendRequest) {
    try {
      sendRequest = await createSendRequest(prisma, {
        shopDomain: params.shopDomain,
        templateId: template.id,
        requestSource: "STOREFRONT_PAGE",
        requestKey: params.input.requestKey,
        recipientEmail: params.input.email,
        recipientName: params.input.name,
        recaptchaAction: env.recaptchaAction,
        emailProvider: env.provider,
        userAgent: params.request.headers.get("user-agent"),
        ipHash,
        pagePath: params.input.pagePath,
      });
    } catch (error) {
      if (!params.input.requestKey || !isRequestKeyCreateConflict(error)) {
        throw error;
      }

      const existing = await getLatestSendRequestByRequestKey(prisma, {
        shopDomain: params.shopDomain,
        requestKey: params.input.requestKey,
      });
      const reconciled = await reconcileExistingStorefrontRequestKey({
        prisma,
        existingRequest: existing,
        templateId: template.id,
        recipientEmail: params.input.email,
        recipientName: params.input.name,
        request: params.request,
        pagePath: params.input.pagePath,
        ipHash,
        emailProvider: env.provider,
        recaptchaAction: env.recaptchaAction,
      });

      if (reconciled?.kind === "duplicate") {
        return {
          requestId: reconciled.requestId,
          duplicate: true,
          sentAt: reconciled.sentAt,
        };
      }

      if (reconciled?.kind === "retry") {
        sendRequest = reconciled.sendRequest;
      } else {
        throw error;
      }
    }
  }

  if (!template.isActive) {
    await markSendRequestFailed(prisma, {
      id: sendRequest.id,
      status: "BLOCKED",
      failureCode: ErrorCode.MAILER_TEMPLATE_INACTIVE,
      failureReason: "Template is inactive.",
    });
    throw new MailerServiceError(ErrorCode.MAILER_TEMPLATE_INACTIVE);
  }

  const rateLimit = await registerStorefrontRateLimitAttempt({
    prisma,
    shopDomain: params.shopDomain,
    recipientEmail: params.input.email,
    ipHash,
    templateId: template.id,
    pagePath: params.input.pagePath || null,
  });

  if (rateLimit.blocked) {
    await markSendRequestFailed(prisma, {
      id: sendRequest.id,
      status: "BLOCKED",
      failureCode: ErrorCode.MAILER_RATE_LIMITED,
      failureReason: `Blocked targets: ${rateLimit.blockedTargets.join(", ")}`,
    });
    throw new MailerServiceError(
      ErrorCode.MAILER_RATE_LIMITED,
      undefined,
      rateLimit.blockedTargets.length > 0
        ? { blockedTargets: rateLimit.blockedTargets }
        : undefined,
    );
  }

  let recaptcha: Awaited<ReturnType<typeof verifyRecaptchaToken>>;
  try {
    recaptcha = await verifyRecaptchaToken({
      secretKey: env.recaptchaSecretKey!,
      token: params.input.recaptchaToken,
      expectedAction: env.recaptchaAction,
      threshold: env.recaptchaThreshold,
      remoteIp: clientIp,
    });
  } catch (error) {
    await markSendRequestFailed(prisma, {
      id: sendRequest.id,
      status: "FAILED",
      failureCode: ErrorCode.MAILER_RECAPTCHA_FAILED,
      failureReason: error instanceof Error ? error.message : String(error),
    });

    throw new MailerServiceError(
      ErrorCode.MAILER_RECAPTCHA_FAILED,
      error instanceof Error ? error.message : String(error),
    );
  }

  await updateSendRequest(prisma, {
    id: sendRequest.id,
    recipientName: params.input.name,
    recaptchaAction: recaptcha.action,
    recaptchaScore: recaptcha.score,
    recaptchaSuccess: recaptcha.success,
  });

  if (!recaptcha.success) {
    await markSendRequestFailed(prisma, {
      id: sendRequest.id,
      status: "BLOCKED",
      failureCode: ErrorCode.MAILER_RECAPTCHA_FAILED,
      failureReason: [
        recaptcha.action ? `action=${recaptcha.action}` : null,
        recaptcha.score !== null ? `score=${recaptcha.score}` : null,
        recaptcha.errorCodes.length > 0 ? `errors=${recaptcha.errorCodes.join(",")}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    });

    throw new MailerServiceError(ErrorCode.MAILER_RECAPTCHA_FAILED);
  }

  const delivered = await deliverMailForSendRequest({
    prisma,
    template,
    sendRequestId: sendRequest.id,
    recipientEmail: params.input.email,
    recipientName: params.input.name,
    shopDomain: params.shopDomain,
    shopName: params.shopDomain,
    pagePath: params.input.pagePath || null,
    requestSource: "STOREFRONT_PAGE",
  });

  return {
    requestId: delivered.requestId,
    duplicate: false,
    sentAt: delivered.sentAt,
  };
}

export async function hasReceivedSqueezeMail(
  prisma: MailerDbClient,
  params: {
    shopDomain: string;
    recipientEmail: string;
  },
) {
  const normalizedEmail = params.recipientEmail.trim().toLowerCase();
  const emailCandidates = Array.from(
    new Set([params.recipientEmail.trim(), normalizedEmail].filter(Boolean)),
  );
  const squeezeTemplates = await prisma.mailTemplate.findMany({
    where: {
      shopDomain: params.shopDomain,
      slug: "squeeze",
    },
    select: {
      id: true,
    },
  });
  const squeezeTemplateIds = squeezeTemplates.map((template) => template.id);

  const existing = await prisma.mailSendRequest.findFirst({
    where: {
      shopDomain: params.shopDomain,
      status: "SENT",
      recipientEmail: {
        in: emailCandidates,
      },
      OR: [
        { templateSlugSnapshot: "squeeze" },
        ...(squeezeTemplateIds.length > 0 ? [{ templateId: { in: squeezeTemplateIds } }] : []),
      ],
    },
    select: {
      id: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  return Boolean(existing);
}

export async function sendCustomerRegistrationMail(
  params: SendCustomerRegistrationMailParams,
): Promise<SendCustomerRegistrationMailResult> {
  const prisma = params.prisma || db;
  const recipientEmail = params.recipientEmail.trim().toLowerCase();
  if (params.registrationSource !== "verified-web-session") {
    throw new MailerServiceError(ErrorCode.AUTH_LOGIN_REQUIRED);
  }
  const hadSqueezeMail = await hasReceivedSqueezeMail(prisma, {
    shopDomain: params.shopDomain,
    recipientEmail,
  });
  // Prior free-kit delivery must not suppress a later verified registration.

  const env = assertMailerRuntimeConfigured();
  const templateSlug = "register-no-squeeze";
  const template = await getTemplateBySlug(prisma, {
    shopDomain: params.shopDomain,
    slug: templateSlug,
    activeOnly: false,
  });

  if (!template) {
    throw new MailerServiceError(ErrorCode.MAILER_TEMPLATE_NOT_FOUND, undefined, {
      templateSlug,
    });
  }

  const claim = await claimRegistrationDelivery(prisma, {
    shopDomain: params.shopDomain,
    customerId: params.customerId,
    templateId: template.id,
    recipientEmail,
    recipientName: params.recipientName,
    emailProvider: env.provider,
  });
  if (!claim.claimed) {
    if (claim.request.status !== "SENT") {
      throw new MailerServiceError(
        ErrorCode.INTERNAL_CONFLICT,
        "Registration delivery requires reconciliation; no automatic resend.",
      );
    }
    return {
      requestId: claim.request.id,
      sentAt: (claim.request.sentAt || claim.request.createdAt).toISOString(),
      templateSlug,
      hadSqueezeMail,
      skippedDueToSqueeze: false,
    };
  }
  const sendRequest = claim.request;

  const delivered = await deliverMailForSendRequest({
    prisma,
    template,
    sendRequestId: sendRequest.id,
    recipientEmail,
    recipientName: params.recipientName,
    shopDomain: params.shopDomain,
    shopName: params.shopDomain,
    pagePath: "/proxy/bta/coupons/registration",
    requestSource: "INTERNAL_TRIGGER",
    customerId: params.customerId,
  });

  return {
    ...delivered,
    templateSlug,
    hadSqueezeMail,
    skippedDueToSqueeze: false,
  };
}

export async function sendAdminTemplateTestMail(params: SendAdminTemplateTestMailParams) {
  const prisma = params.prisma || db;
  const env = assertMailerRuntimeConfigured();
  const template = await getTemplateForShopById(prisma, {
    shopDomain: params.shopDomain,
    templateId: params.templateId,
  });

  const sendRequest = await createSendRequest(prisma, {
    shopDomain: params.shopDomain,
    templateId: template.id,
    requestSource: "ADMIN_TEST",
    recipientEmail: params.recipientEmail,
    recipientName: params.recipientName,
    emailProvider: env.provider,
    userAgent: "admin-test-send",
  });

  return deliverMailForSendRequest({
    prisma,
    template,
    sendRequestId: sendRequest.id,
    recipientEmail: params.recipientEmail,
    recipientName: params.recipientName,
    shopDomain: params.shopDomain,
    shopName: params.shopDomain,
    requestSource: "ADMIN_TEST",
    allowInactive: true,
  });
}

export async function resendFailedMailRequest(params: ResendFailedMailRequestParams) {
  const prisma = params.prisma || db;
  const env = assertMailerRuntimeConfigured();
  const original = await getSendRequestDetail(prisma, params.sendRequestId);

  if (!original || original.shopDomain !== params.shopDomain) {
    throw new MailerServiceError(ErrorCode.MAILER_INVALID_INPUT);
  }

  if (original.status !== "FAILED") {
    throw new MailerServiceError(
      ErrorCode.MAILER_INVALID_INPUT,
      "FAILED 상태 로그만 재발송할 수 있습니다.",
    );
  }

  const template = await getTemplateForShopById(prisma, {
    shopDomain: params.shopDomain,
    templateId: original.templateId,
  });

  const sendRequest = await createSendRequest(prisma, {
    shopDomain: params.shopDomain,
    templateId: template.id,
    requestSource: "INTERNAL_TRIGGER",
    requestKey: `resend:${original.id}:${Date.now()}`,
    recipientEmail: original.recipientEmail,
    recipientName: original.recipientName,
    emailProvider: env.provider,
    pagePath: original.pagePath,
    userAgent: "admin-resend",
  });

  if (hasHistoricalSnapshot(original)) {
    let resolvedAttachments: ResolvedAttachmentSet;

    try {
      resolvedAttachments = await resolveHistoricalSendRequestAttachments({
        attachments: original.attachments,
        attachmentMode: original.attachmentModeSnapshot,
        maxAttachmentBytes: env.maxAttachmentBytes,
        maxTemplateAttachmentCount: env.maxTemplateAttachmentCount,
        maxTotalAttachmentBytes: env.maxTotalAttachmentBytes,
      });
    } catch (error) {
      const failureCode =
        error instanceof MailerServiceError ? error.code : ErrorCode.MAILER_ATTACHMENT_INVALID;

      await markSendRequestFailed(prisma, {
        id: sendRequest.id,
        status: "FAILED",
        failureCode,
        failureReason: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof MailerServiceError) {
        throw error;
      }

      throw new MailerServiceError(
        ErrorCode.MAILER_ATTACHMENT_INVALID,
        error instanceof Error ? error.message : String(error),
      );
    }

    return sendPreparedMailForSendRequest({
      prisma,
      env,
      sendRequestId: sendRequest.id,
      recipientEmail: original.recipientEmail,
      recipientName: original.recipientName,
      snapshot: {
        templateNameSnapshot: original.templateNameSnapshot || template.name,
        templateSlugSnapshot: original.templateSlugSnapshot || template.slug,
        attachmentModeSnapshot: original.attachmentModeSnapshot,
        subjectSnapshot: original.subjectSnapshot,
        htmlBodySnapshot: original.htmlBodySnapshot,
        textBodySnapshot:
          original.textBodySnapshot ||
          renderMailTemplate({
            subject: original.subjectSnapshot,
            htmlBody: original.htmlBodySnapshot,
            textBody: original.textBodySnapshot,
            variables: {
              shopName: params.shopDomain,
              recipientEmail: original.recipientEmail,
              pagePath: original.pagePath || "",
              sentAt: original.sentAt?.toISOString() || original.createdAt.toISOString(),
            },
          }).textBody,
        fromNameSnapshot: original.fromNameSnapshot || template.fromName || env.fromName || null,
        replyToSnapshot: original.replyToSnapshot || template.replyTo || env.replyToEmail || null,
      },
      resolvedAttachments,
      mailEventContext: {
        shopDomain: params.shopDomain,
        requestSource: "INTERNAL_TRIGGER",
        pagePath: original.pagePath,
        customerId: null,
      },
    });
  }

  return deliverMailForSendRequest({
    prisma,
    template,
    sendRequestId: sendRequest.id,
    recipientEmail: original.recipientEmail,
    recipientName: original.recipientName,
    shopDomain: params.shopDomain,
    shopName: params.shopDomain,
    pagePath: original.pagePath,
    requestSource: "INTERNAL_TRIGGER",
    allowInactive: true,
  });
}
