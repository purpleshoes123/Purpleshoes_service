import type { Prisma, PrismaClient } from "@prisma/client";

export type MailerDbClient = PrismaClient | Prisma.TransactionClient;

export function clampListLimit(limit?: number | null, fallback = 20, max = 100) {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

export function normalizeOptionalString(value?: string | null): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

export function normalizeRequiredString(field: string, value?: string | null) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

export function normalizeDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${String(value)}`);
  }
  return date;
}
