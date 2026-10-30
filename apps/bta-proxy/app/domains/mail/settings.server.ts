import db from "~/db.server.ts";
import {
  MAILER_ATTACHMENT_STORAGE_TYPE_VALUES,
  type MailAttachmentStorageType,
} from "~/domains/mail/contracts";
import { getMailerEnvSummary, type MailerEnvSummary } from "~/domains/mail/env";
import type { MailerDbClient } from "~/domains/mail/store.shared.ts";

const RECENT_ACTIVITY_WINDOW_HOURS = 24;

export type MailerDiagnosticsStatus = "SEND_READY" | "RUNTIME_PENDING" | "NEEDS_CONFIG";

export type MailerSettingsSnapshot = MailerEnvSummary & {
  shopDomain: string;
  storage: {
    preferredType: MailAttachmentStorageType;
    supportedTypes: MailAttachmentStorageType[];
  };
  persistence: {
    templateCount: number;
    activeTemplateCount: number;
    attachmentCount: number;
    sendRequestCount: number;
    pendingCount: number;
    sentCount: number;
    failedCount: number;
    blockedCount: number;
    rateCounterCount: number;
  };
  activity: {
    recentWindowHours: number;
    recentRequestCount: number;
    recentPendingCount: number;
    recentSentCount: number;
    recentFailedCount: number;
    recentBlockedCount: number;
    lastTemplateUpdatedAt: string | null;
    lastRequestCreatedAt: string | null;
    lastSentAt: string | null;
    lastFailedAt: string | null;
    latestFailureCode: string | null;
  };
  diagnostics: {
    status: MailerDiagnosticsStatus;
    summary: string;
    warnings: string[];
    nextActions: string[];
    providerNotes: string[];
  };
};

function toIsoString(value?: Date | null) {
  return value ? value.toISOString() : null;
}

function buildProviderNotes(snapshot: MailerEnvSummary): string[] {
  switch (snapshot.provider) {
    case "SMTP":
      return [
        "Use the full mailbox address in SMTP_USERNAME.",
        "For Gmail or Google Workspace app passwords, start with smtp.gmail.com on port 465 with secure=true.",
        "If you use port 587, pair it with secure=false so STARTTLS can upgrade the connection.",
      ];
    case "AWS_SES":
      return [
        "Verify the MAIL_FROM_EMAIL sender identity or domain in Amazon SES before live sends.",
        "Set AWS_SES_CONFIGURATION_SET only when you need delivery-event tracking or tagging.",
        "Use AWS_SES_SOURCE_ARN when MAIL_FROM_EMAIL belongs to a delegated SES identity.",
      ];
    case "SENDGRID":
    case "RESEND":
      return [
        "This build can show env readiness for the provider, but runtime delivery is not implemented yet.",
      ];
    default:
      return [];
  }
}

function buildDiagnostics(params: {
  snapshot: MailerEnvSummary;
  persistence: MailerSettingsSnapshot["persistence"];
  activity: MailerSettingsSnapshot["activity"];
}): MailerSettingsSnapshot["diagnostics"] {
  const { snapshot, persistence, activity } = params;
  const status: MailerDiagnosticsStatus = !snapshot.envConfigured
    ? "NEEDS_CONFIG"
    : !snapshot.runtimeReady
      ? "RUNTIME_PENDING"
      : "SEND_READY";

  const warnings: string[] = [];
  const nextActions: string[] = [];

  if (snapshot.missing.length > 0) {
    warnings.push(`Missing required env: ${snapshot.missing.join(", ")}`);
    nextActions.push("Fill the missing env keys and redeploy the admin runtime.");
  }

  if (snapshot.runtimeIssue) {
    warnings.push(`Runtime issue: ${snapshot.runtimeIssue}`);
    nextActions.push("Switch to an implemented provider or ship the missing provider runtime.");
  }

  if (persistence.templateCount === 0) {
    warnings.push("No templates exist yet.");
    nextActions.push("Create the first mail template before storefront traffic is enabled.");
  } else if (persistence.activeTemplateCount === 0) {
    warnings.push("Templates exist, but none are active.");
    nextActions.push("Activate at least one template before storefront traffic is enabled.");
  }

  if (persistence.sendRequestCount === 0) {
    warnings.push("No send history exists yet.");
    if (snapshot.provider === "SMTP" && snapshot.envConfigured && snapshot.runtimeReady) {
      nextActions.push(
        "Run the SMTP connection check in Mail Settings before the first live send.",
      );
    }
    nextActions.push("Run one admin test send or storefront smoke request to validate delivery.");
  }

  if (activity.recentFailedCount > 0 && activity.recentSentCount === 0) {
    warnings.push(
      `Recent traffic has ${activity.recentFailedCount} failure(s) and no successful sends in the last ${activity.recentWindowHours} hours.`,
    );
    nextActions.push("Review failed logs before expanding live traffic.");
  }

  if (activity.recentBlockedCount > 0) {
    warnings.push(`Recent traffic has ${activity.recentBlockedCount} blocked request(s).`);
    nextActions.push("Re-check rate-limit thresholds and storefront retry behavior.");
  }

  if (persistence.pendingCount > 0) {
    warnings.push(
      `${persistence.pendingCount} pending log(s) still need to resolve to SENT or FAILED.`,
    );
    nextActions.push("Inspect pending logs and confirm provider responses are being finalized.");
  }

  const summary =
    status === "NEEDS_CONFIG"
      ? "Required mailer env is still missing, so the send flow is not ready."
      : status === "RUNTIME_PENDING"
        ? "Env is configured, but the selected provider runtime is not available in this build."
        : warnings.length > 0
          ? "Runtime is ready, but operator follow-up is still required before full rollout."
          : "Runtime is ready for live sends with the current provider configuration.";

  return {
    status,
    summary,
    warnings,
    nextActions: Array.from(new Set(nextActions)),
    providerNotes: buildProviderNotes(snapshot),
  };
}

export async function getMailerSettingsSnapshot(params: {
  shopDomain: string;
  prisma?: MailerDbClient;
}): Promise<MailerSettingsSnapshot> {
  const prisma = params.prisma || db;
  const env = getMailerEnvSummary();
  const shopDomain = params.shopDomain;
  const recentWindowStart = new Date(Date.now() - RECENT_ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000);
  const templateIds = (
    await prisma.mailTemplate.findMany({
      where: { shopDomain, deletedAt: null },
      select: { id: true },
    })
  ).map((item) => item.id);

  const [
    templateCount,
    activeTemplateCount,
    attachmentCount,
    sendRequestCount,
    pendingCount,
    sentCount,
    failedCount,
    blockedCount,
    rateCounterCount,
    recentRequestCount,
    recentPendingCount,
    recentSentCount,
    recentFailedCount,
    recentBlockedCount,
    latestTemplate,
    latestRequest,
    latestSentRequest,
    latestFailedRequest,
  ] = await Promise.all([
    prisma.mailTemplate.count({
      where: { shopDomain, deletedAt: null },
    }),
    prisma.mailTemplate.count({
      where: { shopDomain, deletedAt: null, isActive: true },
    }),
    templateIds.length > 0
      ? prisma.mailTemplateAttachment.count({
          where: {
            templateId: {
              in: templateIds,
            },
          },
        })
      : Promise.resolve(0),
    prisma.mailSendRequest.count({
      where: { shopDomain },
    }),
    prisma.mailSendRequest.count({
      where: { shopDomain, status: "PENDING" },
    }),
    prisma.mailSendRequest.count({
      where: { shopDomain, status: "SENT" },
    }),
    prisma.mailSendRequest.count({
      where: { shopDomain, status: "FAILED" },
    }),
    prisma.mailSendRequest.count({
      where: { shopDomain, status: "BLOCKED" },
    }),
    prisma.mailRateLimitCounter.count({
      where: { shopDomain },
    }),
    prisma.mailSendRequest.count({
      where: {
        shopDomain,
        createdAt: {
          gte: recentWindowStart,
        },
      },
    }),
    prisma.mailSendRequest.count({
      where: {
        shopDomain,
        status: "PENDING",
        createdAt: {
          gte: recentWindowStart,
        },
      },
    }),
    prisma.mailSendRequest.count({
      where: {
        shopDomain,
        status: "SENT",
        createdAt: {
          gte: recentWindowStart,
        },
      },
    }),
    prisma.mailSendRequest.count({
      where: {
        shopDomain,
        status: "FAILED",
        createdAt: {
          gte: recentWindowStart,
        },
      },
    }),
    prisma.mailSendRequest.count({
      where: {
        shopDomain,
        status: "BLOCKED",
        createdAt: {
          gte: recentWindowStart,
        },
      },
    }),
    prisma.mailTemplate.findFirst({
      where: { shopDomain, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    prisma.mailSendRequest.findFirst({
      where: { shopDomain },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.mailSendRequest.findFirst({
      where: { shopDomain, status: "SENT", sentAt: { not: null } },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    }),
    prisma.mailSendRequest.findFirst({
      where: { shopDomain, status: "FAILED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, failureCode: true },
    }),
  ]);

  const activity: MailerSettingsSnapshot["activity"] = {
    recentWindowHours: RECENT_ACTIVITY_WINDOW_HOURS,
    recentRequestCount,
    recentPendingCount,
    recentSentCount,
    recentFailedCount,
    recentBlockedCount,
    lastTemplateUpdatedAt: toIsoString(latestTemplate?.updatedAt),
    lastRequestCreatedAt: toIsoString(latestRequest?.createdAt),
    lastSentAt: toIsoString(latestSentRequest?.sentAt),
    lastFailedAt: toIsoString(latestFailedRequest?.createdAt),
    latestFailureCode: latestFailedRequest?.failureCode || null,
  };

  const persistence: MailerSettingsSnapshot["persistence"] = {
    templateCount,
    activeTemplateCount,
    attachmentCount,
    sendRequestCount,
    pendingCount,
    sentCount,
    failedCount,
    blockedCount,
    rateCounterCount,
  };

  return {
    ...env,
    shopDomain,
    storage: {
      preferredType: "SHOPIFY_FILE",
      supportedTypes: [...MAILER_ATTACHMENT_STORAGE_TYPE_VALUES],
    },
    persistence,
    activity,
    diagnostics: buildDiagnostics({
      snapshot: env,
      persistence,
      activity,
    }),
  };
}
