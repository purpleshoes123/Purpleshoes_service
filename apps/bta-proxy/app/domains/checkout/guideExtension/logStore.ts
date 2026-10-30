import type { PrismaClient } from "@prisma/client";

export type GuideEntitlementLogStatus = "SUCCESS" | "FAILED";

export type GuideEntitlementLogInput = {
  shop: string;
  topic: string;
  customerId: string;
  entitlementType: string;
  eventType: string;
  monthsDelta: number;
  orderId?: string | null;
  refundId?: string | null;
  baseExpiresAt?: string | Date | null;
  previousExpiresAt?: string | Date | null;
  newExpiresAt?: string | Date | null;
  status: GuideEntitlementLogStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  rawRef?: string | null;
};

type LogFilters = {
  shop: string;
  customerId?: string;
  orderId?: string;
  refundId?: string;
  status?: GuideEntitlementLogStatus;
  entitlementType?: string;
  eventType?: string;
  topic?: string;
};

/**
 * Normalize DateTime values for Prisma writes.
 */
function toDate(value?: string | Date | null): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

/**
 * Insert a GuideEntitlementLog record.
 */
export async function createLog(
  prisma: PrismaClient,
  input: GuideEntitlementLogInput,
): Promise<void> {
  await prisma.guideEntitlementLog.create({
    data: {
      shop: input.shop,
      topic: input.topic,
      customerId: input.customerId,
      entitlementType: input.entitlementType,
      eventType: input.eventType,
      monthsDelta: input.monthsDelta,
      orderId: input.orderId || null,
      refundId: input.refundId || null,
      baseExpiresAt: toDate(input.baseExpiresAt),
      previousExpiresAt: toDate(input.previousExpiresAt),
      newExpiresAt: toDate(input.newExpiresAt),
      status: input.status,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      rawRef: input.rawRef || null,
    },
  });
}

/**
 * List logs with filters and cursor-based pagination.
 */
export async function listLogs(
  prisma: PrismaClient,
  params: {
    filters: LogFilters;
    limit: number;
    cursor?: string | null;
  },
): Promise<{
  logs: Array<GuideEntitlementLogInput & { id: string; createdAt: Date }>;
  nextCursor: string | null;
}> {
  const { filters, limit, cursor } = params;
  const where: Record<string, unknown> = {
    shop: filters.shop,
    ...(filters.customerId ? { customerId: filters.customerId } : {}),
    ...(filters.orderId ? { orderId: filters.orderId } : {}),
    ...(filters.refundId ? { refundId: filters.refundId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.entitlementType ? { entitlementType: filters.entitlementType } : {}),
    ...(filters.eventType ? { eventType: filters.eventType } : {}),
    ...(filters.topic ? { topic: filters.topic } : {}),
  };

  const logs = await prisma.guideEntitlementLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const nextCursor = logs.length === limit ? logs[logs.length - 1].id : null;
  return { logs, nextCursor };
}

/**
 * Get a single log by id.
 */
export async function getLogById(
  prisma: PrismaClient,
  id: string,
): Promise<(GuideEntitlementLogInput & { id: string; createdAt: Date }) | null> {
  return prisma.guideEntitlementLog.findUnique({ where: { id } });
}
