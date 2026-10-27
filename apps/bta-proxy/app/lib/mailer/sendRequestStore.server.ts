import type {
  MailSendRequest,
  MailSendRequestAttachment,
  Prisma,
} from "@prisma/client";
import { maskEmail } from "~/lib/masking";
import {
  DEFAULT_MAIL_PROVIDER,
  MAILER_REQUEST_SOURCE_VALUES,
  MAILER_SEND_STATUS_VALUES,
  type MailProviderKey,
  type MailRequestSource,
  type MailSendStatus,
} from "~/lib/mailer/contracts";
import {
  clampListLimit,
  normalizeDate,
  normalizeOptionalString,
  normalizeRequiredString,
  type MailerDbClient,
} from "~/lib/mailer/store.shared";

export type CreateMailSendRequestInput = {
  shopDomain: string;
  templateId: string;
  requestSource?: MailRequestSource;
  requestKey?: string | null;
  recipientEmail: string;
  recipientName?: string | null;
  recaptchaAction?: string | null;
  recaptchaScore?: number | null;
  recaptchaSuccess?: boolean | null;
  status?: MailSendStatus;
  failureCode?: string | null;
  failureReason?: string | null;
  emailProvider?: MailProviderKey;
  providerMessageId?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
  pagePath?: string | null;
  templateNameSnapshot?: string | null;
  templateSlugSnapshot?: string | null;
  attachmentModeSnapshot?: string | null;
  subjectSnapshot?: string | null;
  htmlBodySnapshot?: string | null;
  textBodySnapshot?: string | null;
  fromNameSnapshot?: string | null;
  replyToSnapshot?: string | null;
  sentAt?: string | Date | null;
};

export type CreateMailSendRequestAttachmentInput = {
  sendRequestId: string;
  templateAttachmentId?: string | null;
  resolvedFileUrl: string;
  resolvedFileName: string;
  resolvedMimeType: string;
  resolvedFileSizeBytes: number;
};

export type UpdateMailSendRequestInput = {
  id: string;
  requestSource?: MailRequestSource;
  requestKey?: string | null;
  recipientName?: string | null;
  recaptchaAction?: string | null;
  recaptchaScore?: number | null;
  recaptchaSuccess?: boolean | null;
  status?: MailSendStatus;
  failureCode?: string | null;
  failureReason?: string | null;
  emailProvider?: MailProviderKey;
  providerMessageId?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
  pagePath?: string | null;
  templateNameSnapshot?: string | null;
  templateSlugSnapshot?: string | null;
  attachmentModeSnapshot?: string | null;
  subjectSnapshot?: string | null;
  htmlBodySnapshot?: string | null;
  textBodySnapshot?: string | null;
  fromNameSnapshot?: string | null;
  replyToSnapshot?: string | null;
  sentAt?: string | Date | null;
};

export type ListMailSendRequestsParams = {
  shopDomain: string;
  templateId?: string;
  status?: MailSendStatus;
  requestSource?: MailRequestSource;
  recipientEmailQuery?: string;
  pagePathQuery?: string;
  minRecaptchaScore?: number;
  maxRecaptchaScore?: number;
  createdFrom?: string | Date | null;
  createdTo?: string | Date | null;
  limit?: number;
  cursor?: string | null;
};

export type MailSendRequestSummary = MailSendRequest & {
  maskedRecipientEmail: string;
};

export type MailSendRequestDetail = MailSendRequestSummary & {
  attachments: MailSendRequestAttachment[];
};

function resolveRequestSource(value?: string | null): MailRequestSource {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return (MAILER_REQUEST_SOURCE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as MailRequestSource)
    : "STOREFRONT_PAGE";
}

function resolveSendStatus(value?: string | null): MailSendStatus {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return (MAILER_SEND_STATUS_VALUES as readonly string[]).includes(normalized)
    ? (normalized as MailSendStatus)
    : "PENDING";
}

function buildSendRequestWhere(
  params: ListMailSendRequestsParams
): Prisma.MailSendRequestWhereInput {
  const createdFrom = normalizeDate(params.createdFrom);
  const createdTo = normalizeDate(params.createdTo);
  const recipientEmailQuery = normalizeOptionalString(params.recipientEmailQuery);
  const pagePathQuery = normalizeOptionalString(params.pagePathQuery);

  return {
    shopDomain: normalizeRequiredString("shopDomain", params.shopDomain),
    ...(params.templateId ? { templateId: params.templateId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.requestSource ? { requestSource: params.requestSource } : {}),
    ...(recipientEmailQuery
      ? { recipientEmail: { contains: recipientEmailQuery } }
      : {}),
    ...(pagePathQuery ? { pagePath: { contains: pagePathQuery } } : {}),
    ...(createdFrom || createdTo
      ? {
          createdAt: {
            ...(createdFrom ? { gte: createdFrom } : {}),
            ...(createdTo ? { lte: createdTo } : {}),
          },
        }
      : {}),
    ...(params.minRecaptchaScore !== undefined ||
    params.maxRecaptchaScore !== undefined
      ? {
          recaptchaScore: {
            ...(params.minRecaptchaScore !== undefined
              ? { gte: params.minRecaptchaScore }
              : {}),
            ...(params.maxRecaptchaScore !== undefined
              ? { lte: params.maxRecaptchaScore }
              : {}),
          },
        }
      : {}),
  };
}

export async function createSendRequest(
  prisma: MailerDbClient,
  input: CreateMailSendRequestInput
) {
  return prisma.mailSendRequest.create({
    data: {
      shopDomain: normalizeRequiredString("shopDomain", input.shopDomain),
      templateId: normalizeRequiredString("templateId", input.templateId),
      requestSource: resolveRequestSource(input.requestSource),
      requestKey: normalizeOptionalString(input.requestKey),
      recipientEmail: normalizeRequiredString(
        "recipientEmail",
        input.recipientEmail
      ),
      recipientName: normalizeOptionalString(input.recipientName),
      recaptchaAction: normalizeOptionalString(input.recaptchaAction),
      recaptchaScore:
        input.recaptchaScore === undefined ? null : input.recaptchaScore,
      recaptchaSuccess:
        input.recaptchaSuccess === undefined ? null : input.recaptchaSuccess,
      status: resolveSendStatus(input.status),
      failureCode: normalizeOptionalString(input.failureCode),
      failureReason: normalizeOptionalString(input.failureReason),
      emailProvider: input.emailProvider || DEFAULT_MAIL_PROVIDER,
      providerMessageId: normalizeOptionalString(input.providerMessageId),
      userAgent: normalizeOptionalString(input.userAgent),
      ipHash: normalizeOptionalString(input.ipHash),
      pagePath: normalizeOptionalString(input.pagePath),
      templateNameSnapshot: normalizeOptionalString(input.templateNameSnapshot),
      templateSlugSnapshot: normalizeOptionalString(input.templateSlugSnapshot),
      attachmentModeSnapshot: normalizeOptionalString(input.attachmentModeSnapshot),
      subjectSnapshot: normalizeOptionalString(input.subjectSnapshot),
      htmlBodySnapshot: normalizeOptionalString(input.htmlBodySnapshot),
      textBodySnapshot: normalizeOptionalString(input.textBodySnapshot),
      fromNameSnapshot: normalizeOptionalString(input.fromNameSnapshot),
      replyToSnapshot: normalizeOptionalString(input.replyToSnapshot),
      sentAt: normalizeDate(input.sentAt),
    },
  });
}

export async function markSendRequestSent(
  prisma: MailerDbClient,
  params: {
    id: string;
    providerMessageId?: string | null;
    sentAt?: string | Date | null;
  }
) {
  return prisma.mailSendRequest.update({
    where: { id: params.id },
    data: {
      status: "SENT",
      providerMessageId: normalizeOptionalString(params.providerMessageId),
      failureCode: null,
      failureReason: null,
      sentAt: normalizeDate(params.sentAt) || new Date(),
    },
  });
}

export async function markSendRequestFailed(
  prisma: MailerDbClient,
  params: {
    id: string;
    status?: Extract<MailSendStatus, "FAILED" | "BLOCKED">;
    failureCode?: string | null;
    failureReason?: string | null;
  }
) {
  const status = params.status === "BLOCKED" ? "BLOCKED" : "FAILED";
  return prisma.mailSendRequest.update({
    where: { id: params.id },
    data: {
      status,
      failureCode: normalizeOptionalString(params.failureCode),
      failureReason: normalizeOptionalString(params.failureReason),
      sentAt: null,
      providerMessageId: null,
    },
  });
}

export async function updateSendRequest(
  prisma: MailerDbClient,
  input: UpdateMailSendRequestInput
) {
  const data: Prisma.MailSendRequestUpdateInput = {
    ...(input.requestSource !== undefined
      ? { requestSource: resolveRequestSource(input.requestSource) }
      : {}),
    ...(input.requestKey !== undefined
      ? { requestKey: normalizeOptionalString(input.requestKey) }
      : {}),
    ...(input.recipientName !== undefined
      ? { recipientName: normalizeOptionalString(input.recipientName) }
      : {}),
    ...(input.recaptchaAction !== undefined
      ? { recaptchaAction: normalizeOptionalString(input.recaptchaAction) }
      : {}),
    ...(input.recaptchaScore !== undefined
      ? { recaptchaScore: input.recaptchaScore }
      : {}),
    ...(input.recaptchaSuccess !== undefined
      ? { recaptchaSuccess: input.recaptchaSuccess }
      : {}),
    ...(input.status !== undefined
      ? { status: resolveSendStatus(input.status) }
      : {}),
    ...(input.failureCode !== undefined
      ? { failureCode: normalizeOptionalString(input.failureCode) }
      : {}),
    ...(input.failureReason !== undefined
      ? { failureReason: normalizeOptionalString(input.failureReason) }
      : {}),
    ...(input.emailProvider !== undefined
      ? { emailProvider: input.emailProvider || DEFAULT_MAIL_PROVIDER }
      : {}),
    ...(input.providerMessageId !== undefined
      ? { providerMessageId: normalizeOptionalString(input.providerMessageId) }
      : {}),
    ...(input.userAgent !== undefined
      ? { userAgent: normalizeOptionalString(input.userAgent) }
      : {}),
    ...(input.ipHash !== undefined
      ? { ipHash: normalizeOptionalString(input.ipHash) }
      : {}),
    ...(input.pagePath !== undefined
      ? { pagePath: normalizeOptionalString(input.pagePath) }
      : {}),
    ...(input.templateNameSnapshot !== undefined
      ? {
          templateNameSnapshot: normalizeOptionalString(input.templateNameSnapshot),
        }
      : {}),
    ...(input.templateSlugSnapshot !== undefined
      ? {
          templateSlugSnapshot: normalizeOptionalString(input.templateSlugSnapshot),
        }
      : {}),
    ...(input.attachmentModeSnapshot !== undefined
      ? {
          attachmentModeSnapshot: normalizeOptionalString(
            input.attachmentModeSnapshot
          ),
        }
      : {}),
    ...(input.subjectSnapshot !== undefined
      ? { subjectSnapshot: normalizeOptionalString(input.subjectSnapshot) }
      : {}),
    ...(input.htmlBodySnapshot !== undefined
      ? { htmlBodySnapshot: normalizeOptionalString(input.htmlBodySnapshot) }
      : {}),
    ...(input.textBodySnapshot !== undefined
      ? { textBodySnapshot: normalizeOptionalString(input.textBodySnapshot) }
      : {}),
    ...(input.fromNameSnapshot !== undefined
      ? { fromNameSnapshot: normalizeOptionalString(input.fromNameSnapshot) }
      : {}),
    ...(input.replyToSnapshot !== undefined
      ? { replyToSnapshot: normalizeOptionalString(input.replyToSnapshot) }
      : {}),
    ...(input.sentAt !== undefined
      ? { sentAt: normalizeDate(input.sentAt) }
      : {}),
  };

  return prisma.mailSendRequest.update({
    where: { id: input.id },
    data,
  });
}

export async function listSendRequests(
  prisma: MailerDbClient,
  params: ListMailSendRequestsParams
): Promise<{ items: MailSendRequestSummary[]; nextCursor: string | null }> {
  const limit = clampListLimit(params.limit, 20, 100);
  const items = await prisma.mailSendRequest.findMany({
    where: buildSendRequestWhere(params),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  return {
    items: items.map((item) => ({
      ...item,
      maskedRecipientEmail: maskEmail(item.recipientEmail),
    })),
    nextCursor: items.length === limit ? items[items.length - 1].id : null,
  };
}

export async function getSendRequestById(prisma: MailerDbClient, id: string) {
  return prisma.mailSendRequest.findUnique({
    where: { id },
  });
}

export async function getLatestSendRequestByRequestKey(
  prisma: MailerDbClient,
  params: {
    shopDomain: string;
    requestKey: string;
  }
) {
  return prisma.mailSendRequest.findFirst({
    where: {
      shopDomain: normalizeRequiredString("shopDomain", params.shopDomain),
      requestKey: normalizeRequiredString("requestKey", params.requestKey),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function deleteSendRequestAttachments(
  prisma: MailerDbClient,
  sendRequestId: string
) {
  return prisma.mailSendRequestAttachment.deleteMany({
    where: {
      sendRequestId: normalizeRequiredString("sendRequestId", sendRequestId),
    },
  });
}

export async function listSendRequestAttachments(
  prisma: MailerDbClient,
  sendRequestId: string
) {
  return prisma.mailSendRequestAttachment.findMany({
    where: { sendRequestId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function createSendRequestAttachment(
  prisma: MailerDbClient,
  input: CreateMailSendRequestAttachmentInput
) {
  return prisma.mailSendRequestAttachment.create({
    data: {
      sendRequestId: normalizeRequiredString(
        "sendRequestId",
        input.sendRequestId
      ),
      templateAttachmentId: normalizeOptionalString(input.templateAttachmentId),
      resolvedFileUrl: normalizeRequiredString(
        "resolvedFileUrl",
        input.resolvedFileUrl
      ),
      resolvedFileName: normalizeRequiredString(
        "resolvedFileName",
        input.resolvedFileName
      ),
      resolvedMimeType: normalizeRequiredString(
        "resolvedMimeType",
        input.resolvedMimeType
      ),
      resolvedFileSizeBytes: Math.trunc(input.resolvedFileSizeBytes),
    },
  });
}

export async function getSendRequestDetail(
  prisma: MailerDbClient,
  id: string
): Promise<MailSendRequestDetail | null> {
  const request = await getSendRequestById(prisma, id);
  if (!request) return null;

  return {
    ...request,
    maskedRecipientEmail: maskEmail(request.recipientEmail),
    attachments: await listSendRequestAttachments(prisma, id),
  };
}
