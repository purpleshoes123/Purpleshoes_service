import type { MailTemplate, MailTemplateAttachment, Prisma } from "@prisma/client";
import {
  MAILER_ATTACHMENT_MODE_VALUES,
  type MailAttachmentMode,
  type MailAttachmentStorageType,
} from "~/domains/mail/contracts";
import {
  clampListLimit,
  normalizeDate,
  normalizeOptionalString,
  normalizeRequiredString,
  type MailerDbClient,
} from "~/domains/mail/store.shared.ts";

export type CreateMailTemplateInput = {
  shopDomain: string;
  name: string;
  slug: string;
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  isActive?: boolean;
  attachmentMode?: MailAttachmentMode;
};

export type UpdateMailTemplateInput = Partial<Omit<CreateMailTemplateInput, "shopDomain">> & {
  deletedAt?: string | Date | null;
};

export type CreateMailTemplateAttachmentInput = {
  templateId: string;
  storageType: MailAttachmentStorageType;
  shopifyFileId?: string | null;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  sortOrder?: number;
};

export type ListMailTemplatesParams = {
  shopDomain: string;
  includeDeleted?: boolean;
  isActive?: boolean;
  searchQuery?: string;
  limit?: number;
  cursor?: string | null;
};

export type MailTemplateSummary = MailTemplate & {
  attachmentCount: number;
};

export type MailTemplateDetail = MailTemplate & {
  attachments: MailTemplateAttachment[];
};

function resolveAttachmentMode(value?: string | null): MailAttachmentMode {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return (MAILER_ATTACHMENT_MODE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as MailAttachmentMode)
    : "NONE";
}

function buildTemplateWhere(params: ListMailTemplatesParams): Prisma.MailTemplateWhereInput {
  const search = normalizeOptionalString(params.searchQuery);
  return {
    shopDomain: normalizeRequiredString("shopDomain", params.shopDomain),
    ...(params.includeDeleted ? {} : { deletedAt: null }),
    ...(typeof params.isActive === "boolean" ? { isActive: params.isActive } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { slug: { contains: search } },
            { subject: { contains: search } },
          ],
        }
      : {}),
  };
}

export async function createTemplate(prisma: MailerDbClient, input: CreateMailTemplateInput) {
  return prisma.mailTemplate.create({
    data: {
      shopDomain: normalizeRequiredString("shopDomain", input.shopDomain),
      name: normalizeRequiredString("name", input.name),
      slug: normalizeRequiredString("slug", input.slug),
      subject: normalizeRequiredString("subject", input.subject),
      htmlBody: normalizeRequiredString("htmlBody", input.htmlBody),
      textBody: normalizeOptionalString(input.textBody),
      fromName: normalizeOptionalString(input.fromName),
      replyTo: normalizeOptionalString(input.replyTo),
      isActive: input.isActive ?? true,
      attachmentMode: resolveAttachmentMode(input.attachmentMode),
    },
  });
}

export async function updateTemplate(
  prisma: MailerDbClient,
  id: string,
  input: UpdateMailTemplateInput,
) {
  const data: Prisma.MailTemplateUpdateInput = {
    ...(input.name !== undefined ? { name: normalizeRequiredString("name", input.name) } : {}),
    ...(input.slug !== undefined ? { slug: normalizeRequiredString("slug", input.slug) } : {}),
    ...(input.subject !== undefined
      ? { subject: normalizeRequiredString("subject", input.subject) }
      : {}),
    ...(input.htmlBody !== undefined
      ? { htmlBody: normalizeRequiredString("htmlBody", input.htmlBody) }
      : {}),
    ...(input.textBody !== undefined ? { textBody: normalizeOptionalString(input.textBody) } : {}),
    ...(input.fromName !== undefined ? { fromName: normalizeOptionalString(input.fromName) } : {}),
    ...(input.replyTo !== undefined ? { replyTo: normalizeOptionalString(input.replyTo) } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.attachmentMode !== undefined
      ? { attachmentMode: resolveAttachmentMode(input.attachmentMode) }
      : {}),
    ...(input.deletedAt !== undefined ? { deletedAt: normalizeDate(input.deletedAt) } : {}),
  };

  return prisma.mailTemplate.update({
    where: { id },
    data,
  });
}

export async function softDeleteTemplate(prisma: MailerDbClient, id: string) {
  return updateTemplate(prisma, id, {
    isActive: false,
    deletedAt: new Date(),
  });
}

export async function getTemplateById(
  prisma: MailerDbClient,
  id: string,
  options?: { includeDeleted?: boolean },
) {
  return prisma.mailTemplate.findFirst({
    where: {
      id,
      ...(options?.includeDeleted ? {} : { deletedAt: null }),
    },
  });
}

export async function getTemplateBySlug(
  prisma: MailerDbClient,
  params: {
    shopDomain: string;
    slug: string;
    activeOnly?: boolean;
  },
) {
  return prisma.mailTemplate.findFirst({
    where: {
      shopDomain: normalizeRequiredString("shopDomain", params.shopDomain),
      slug: normalizeRequiredString("slug", params.slug),
      deletedAt: null,
      ...(params.activeOnly ? { isActive: true } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
}

export async function isTemplateSlugTaken(
  prisma: MailerDbClient,
  params: {
    shopDomain: string;
    slug: string;
    excludeTemplateId?: string;
  },
) {
  const existing = await prisma.mailTemplate.findFirst({
    where: {
      shopDomain: normalizeRequiredString("shopDomain", params.shopDomain),
      slug: normalizeRequiredString("slug", params.slug),
      deletedAt: null,
      ...(params.excludeTemplateId
        ? {
            id: {
              not: params.excludeTemplateId,
            },
          }
        : {}),
    },
    select: { id: true },
  });

  return Boolean(existing);
}

export async function listTemplates(prisma: MailerDbClient, params: ListMailTemplatesParams) {
  const limit = clampListLimit(params.limit, 20, 100);
  const items = await prisma.mailTemplate.findMany({
    where: buildTemplateWhere(params),
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });

  return {
    items,
    nextCursor: items.length === limit ? items[items.length - 1].id : null,
  };
}

export async function listTemplateSummaries(
  prisma: MailerDbClient,
  params: ListMailTemplatesParams,
): Promise<{ items: MailTemplateSummary[]; nextCursor: string | null }> {
  const listed = await listTemplates(prisma, params);
  const templateIds = listed.items.map((item) => item.id);
  const counts =
    templateIds.length > 0
      ? await prisma.mailTemplateAttachment.groupBy({
          by: ["templateId"],
          where: {
            templateId: { in: templateIds },
          },
          _count: {
            _all: true,
          },
        })
      : [];

  const countMap = new Map(counts.map((item) => [item.templateId, item._count._all]));

  return {
    items: listed.items.map((item) => ({
      ...item,
      attachmentCount: countMap.get(item.id) || 0,
    })),
    nextCursor: listed.nextCursor,
  };
}

export async function listTemplateAttachments(prisma: MailerDbClient, templateId: string) {
  return prisma.mailTemplateAttachment.findMany({
    where: { templateId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

export async function createTemplateAttachment(
  prisma: MailerDbClient,
  input: CreateMailTemplateAttachmentInput,
) {
  return prisma.mailTemplateAttachment.create({
    data: {
      templateId: normalizeRequiredString("templateId", input.templateId),
      storageType: input.storageType,
      shopifyFileId: normalizeOptionalString(input.shopifyFileId),
      fileUrl: normalizeRequiredString("fileUrl", input.fileUrl),
      fileName: normalizeRequiredString("fileName", input.fileName),
      mimeType: normalizeRequiredString("mimeType", input.mimeType),
      fileSizeBytes: Math.trunc(input.fileSizeBytes),
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export async function getTemplateAttachmentById(prisma: MailerDbClient, id: string) {
  return prisma.mailTemplateAttachment.findUnique({
    where: { id },
  });
}

export async function replaceTemplateAttachments(
  prisma: MailerDbClient,
  templateId: string,
  attachments: CreateMailTemplateAttachmentInput[],
) {
  await prisma.$transaction(async (tx) => {
    await tx.mailTemplateAttachment.deleteMany({
      where: { templateId },
    });

    for (const attachment of attachments) {
      await createTemplateAttachment(tx, {
        ...attachment,
        templateId,
      });
    }
  });

  return listTemplateAttachments(prisma, templateId);
}

export async function getTemplateDetail(
  prisma: MailerDbClient,
  id: string,
): Promise<MailTemplateDetail | null> {
  const template = await getTemplateById(prisma, id, { includeDeleted: true });
  if (!template) {
    return null;
  }

  return {
    ...template,
    attachments: await listTemplateAttachments(prisma, id),
  };
}

export async function deleteTemplateAttachment(prisma: MailerDbClient, id: string) {
  return prisma.mailTemplateAttachment.delete({
    where: { id },
  });
}

export async function reorderTemplateAttachments(
  prisma: MailerDbClient,
  templateId: string,
  orderedAttachmentIds: string[],
) {
  const current = await listTemplateAttachments(prisma, templateId);
  const currentIds = current.map((item) => item.id);

  if (
    orderedAttachmentIds.length !== currentIds.length ||
    orderedAttachmentIds.some((id) => !currentIds.includes(id))
  ) {
    throw new Error("첨부파일 정렬 대상이 현재 템플릿과 일치하지 않습니다.");
  }

  await prisma.$transaction(
    orderedAttachmentIds.map((attachmentId, index) =>
      prisma.mailTemplateAttachment.update({
        where: { id: attachmentId },
        data: {
          sortOrder: index,
        },
      }),
    ),
  );

  return listTemplateAttachments(prisma, templateId);
}
