import type { MailRateLimitCounter } from "@prisma/client";
import {
  MAILER_RATE_LIMIT_TARGET_VALUES,
  type MailRateLimitTargetType,
} from "~/lib/mailer/contracts";
import {
  normalizeDate,
  normalizeRequiredString,
  type MailerDbClient,
} from "~/lib/mailer/store.shared";

export type MailRateLimitWindow = {
  windowStartAt: Date;
  windowEndAt: Date;
  durationMs: number;
};

export type RegisterMailRateLimitAttemptInput = {
  shopDomain: string;
  targetType: MailRateLimitTargetType;
  targetKey: string;
  windowMs: number;
  anchorAt?: string | Date | null;
  requestIncrement?: number;
  blocked?: boolean;
};

function resolveRateLimitTargetType(
  value?: string | null
): MailRateLimitTargetType {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return (MAILER_RATE_LIMIT_TARGET_VALUES as readonly string[]).includes(normalized)
    ? (normalized as MailRateLimitTargetType)
    : "EMAIL";
}

export function buildMailRateLimitWindow(
  windowMs: number,
  anchorAt?: string | Date | null
): MailRateLimitWindow {
  const safeWindowMs = Math.max(1, Math.trunc(windowMs));
  const anchor = normalizeDate(anchorAt) || new Date();
  const windowStartMs =
    Math.floor(anchor.getTime() / safeWindowMs) * safeWindowMs;
  const windowEndMs = windowStartMs + safeWindowMs;

  return {
    windowStartAt: new Date(windowStartMs),
    windowEndAt: new Date(windowEndMs),
    durationMs: safeWindowMs,
  };
}

export async function registerMailRateLimitAttempt(
  prisma: MailerDbClient,
  input: RegisterMailRateLimitAttemptInput
) {
  const window = buildMailRateLimitWindow(input.windowMs, input.anchorAt);
  const requestIncrement = Math.max(1, Math.trunc(input.requestIncrement || 1));

  return prisma.mailRateLimitCounter.upsert({
    where: {
      shopDomain_targetType_targetKey_windowStartAt: {
        shopDomain: normalizeRequiredString("shopDomain", input.shopDomain),
        targetType: resolveRateLimitTargetType(input.targetType),
        targetKey: normalizeRequiredString("targetKey", input.targetKey),
        windowStartAt: window.windowStartAt,
      },
    },
    create: {
      shopDomain: normalizeRequiredString("shopDomain", input.shopDomain),
      targetType: resolveRateLimitTargetType(input.targetType),
      targetKey: normalizeRequiredString("targetKey", input.targetKey),
      windowStartAt: window.windowStartAt,
      windowEndAt: window.windowEndAt,
      requestCount: requestIncrement,
      blockedCount: input.blocked ? 1 : 0,
    },
    update: {
      windowEndAt: window.windowEndAt,
      requestCount: { increment: requestIncrement },
      ...(input.blocked ? { blockedCount: { increment: 1 } } : {}),
    },
  });
}

export async function getMailRateLimitCounter(
  prisma: MailerDbClient,
  params: {
    shopDomain: string;
    targetType: MailRateLimitTargetType;
    targetKey: string;
    windowMs: number;
    anchorAt?: string | Date | null;
  }
): Promise<MailRateLimitCounter | null> {
  const window = buildMailRateLimitWindow(params.windowMs, params.anchorAt);
  return prisma.mailRateLimitCounter.findUnique({
    where: {
      shopDomain_targetType_targetKey_windowStartAt: {
        shopDomain: normalizeRequiredString("shopDomain", params.shopDomain),
        targetType: resolveRateLimitTargetType(params.targetType),
        targetKey: normalizeRequiredString("targetKey", params.targetKey),
        windowStartAt: window.windowStartAt,
      },
    },
  });
}

export function isMailRateLimitExceeded(
  counter: Pick<MailRateLimitCounter, "requestCount"> | null,
  limit: number
) {
  if (!counter) return false;
  return counter.requestCount > Math.max(0, Math.trunc(limit));
}
