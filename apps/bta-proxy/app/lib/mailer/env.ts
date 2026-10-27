import { z } from "zod";
import {
  DEFAULT_MAIL_PROVIDER,
  MAILER_DEFAULT_RATE_LIMITS,
  MAILER_DEFAULT_LOG_RETENTION_DAYS,
  MAILER_DEFAULT_RECAPTCHA_ACTION,
  MAILER_DEFAULT_RECAPTCHA_THRESHOLD,
  MAILER_DEFAULT_TEMPLATE_ATTACHMENT_LIMIT,
  MAILER_DEFAULT_TOTAL_ATTACHMENT_BYTES,
  MAILER_MAX_ATTACHMENT_BYTES,
  MAILER_PROVIDER_KEYS,
} from "~/lib/mailer/contracts";
import {
  getMailProviderRuntimeIssue,
  resolveMailProviderKey,
  type MailProviderKey,
} from "~/lib/mailer/provider";

function parseBooleanish(raw?: string | null) {
  if (raw == null) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return raw;
}

const mailerEnvSchema = z.object({
  provider: z.enum(MAILER_PROVIDER_KEYS).default(DEFAULT_MAIL_PROVIDER),
  fromEmail: z.string().email().optional(),
  fromName: z.string().min(1).default("BTA Proxy"),
  replyToEmail: z.string().email().optional(),
  recaptchaSiteKey: z.string().optional(),
  recaptchaSecretKey: z.string().optional(),
  recaptchaAction: z.string().min(1).default(MAILER_DEFAULT_RECAPTCHA_ACTION),
  recaptchaThreshold: z
    .coerce.number()
    .min(0)
    .max(1)
    .default(MAILER_DEFAULT_RECAPTCHA_THRESHOLD),
  maxAttachmentBytes: z.coerce.number().int().positive().default(MAILER_MAX_ATTACHMENT_BYTES),
  maxTemplateAttachmentCount: z
    .coerce.number()
    .int()
    .positive()
    .default(MAILER_DEFAULT_TEMPLATE_ATTACHMENT_LIMIT),
  maxTotalAttachmentBytes: z
    .coerce.number()
    .int()
    .positive()
    .default(MAILER_DEFAULT_TOTAL_ATTACHMENT_BYTES),
  emailRateLimitPer10Min: z
    .coerce.number()
    .int()
    .positive()
    .default(MAILER_DEFAULT_RATE_LIMITS.emailPer10Min),
  ipRateLimitPer10Min: z
    .coerce.number()
    .int()
    .positive()
    .default(MAILER_DEFAULT_RATE_LIMITS.ipPer10Min),
  templateRateLimitPerHour: z
    .coerce.number()
    .int()
    .positive()
    .default(MAILER_DEFAULT_RATE_LIMITS.templatePerHour),
  logRetentionDays: z
    .coerce.number()
    .int()
    .positive()
    .default(MAILER_DEFAULT_LOG_RETENTION_DAYS),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().positive().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
  sesRegion: z.string().optional(),
  sesConfigurationSet: z.string().optional(),
  sesSourceArn: z.string().optional(),
  klaviyoMailEventEnabled: z.boolean().default(false),
  klaviyoPrivateApiKey: z.string().min(1).optional(),
  klaviyoApiRevision: z.string().min(1).default("2026-04-15"),
  klaviyoMailEventMetricName: z.string().min(1).default("BTA Mail Sent"),
  // Squeeze is the only default lead-flow entry point. Other transactional
  // templates may be opted in explicitly through the deployment environment.
  klaviyoMailEventAllowedTemplateSlugs: z.string().min(1).default("squeeze"),
  klaviyoMailEventTimeoutMs: z.coerce.number().int().positive().default(3000),
});

export type MailerEnv = z.infer<typeof mailerEnvSchema>;

export type MailerEnvSummary = {
  provider: MailProviderKey;
  envConfigured: boolean;
  runtimeReady: boolean;
  configured: boolean;
  missing: string[];
  runtimeIssue: string | null;
  recaptcha: {
    enabled: boolean;
    action: string;
    threshold: number;
  };
  providerSettings: {
    apiKeyConfigured: boolean;
    sesRegion: string | null;
    sesConfigurationSetConfigured: boolean;
    sesSourceArnConfigured: boolean;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecure: boolean | null;
    smtpUsernameConfigured: boolean;
    smtpPasswordConfigured: boolean;
  };
  attachmentPolicy: {
    maxAttachmentBytes: number;
    maxTemplateAttachmentCount: number;
    maxTotalAttachmentBytes: number;
  };
  rateLimits: {
    emailPer10Min: number;
    ipPer10Min: number;
    templatePerHour: number;
  };
  retention: {
    logRetentionDays: number;
  };
  klaviyoMailEvents: {
    enabled: boolean;
    apiKeyConfigured: boolean;
    apiRevision: string;
    metricName: string;
    allowedTemplateSlugs: string;
    timeoutMs: number;
  };
};

let cachedMailerEnv: MailerEnv | null = null;

function buildMailerEnvInput() {
  return {
    provider: resolveMailProviderKey(process.env.MAIL_PROVIDER),
    fromEmail: process.env.MAIL_FROM_EMAIL?.trim() || undefined,
    fromName: process.env.MAIL_FROM_NAME?.trim() || undefined,
    replyToEmail:
      process.env.MAIL_REPLY_TO_EMAIL?.trim() || "support@kpurpleshoes.com",
    recaptchaSiteKey: process.env.MAIL_RECAPTCHA_SITE_KEY?.trim() || undefined,
    recaptchaSecretKey: process.env.MAIL_RECAPTCHA_SECRET_KEY?.trim() || undefined,
    recaptchaAction: process.env.MAIL_RECAPTCHA_ACTION?.trim() || undefined,
    recaptchaThreshold: process.env.MAIL_RECAPTCHA_THRESHOLD || undefined,
    maxAttachmentBytes: process.env.MAIL_ATTACHMENT_MAX_BYTES || undefined,
    maxTemplateAttachmentCount:
      process.env.MAIL_TEMPLATE_ATTACHMENT_MAX_COUNT || undefined,
    maxTotalAttachmentBytes:
      process.env.MAIL_ATTACHMENT_TOTAL_MAX_BYTES || undefined,
    emailRateLimitPer10Min:
      process.env.MAIL_RATE_LIMIT_EMAIL_PER_10_MIN || undefined,
    ipRateLimitPer10Min:
      process.env.MAIL_RATE_LIMIT_IP_PER_10_MIN || undefined,
    templateRateLimitPerHour:
      process.env.MAIL_RATE_LIMIT_TEMPLATE_PER_HOUR || undefined,
    logRetentionDays: process.env.MAIL_LOG_RETENTION_DAYS || undefined,
    smtpHost: process.env.SMTP_HOST?.trim() || undefined,
    smtpPort: process.env.SMTP_PORT || undefined,
    smtpSecure: parseBooleanish(process.env.SMTP_SECURE),
    smtpUsername: process.env.SMTP_USERNAME?.trim() || undefined,
    smtpPassword: process.env.SMTP_PASSWORD?.trim() || undefined,
    sesRegion: process.env.AWS_SES_REGION?.trim() || undefined,
    sesConfigurationSet:
      process.env.AWS_SES_CONFIGURATION_SET?.trim() || undefined,
    sesSourceArn: process.env.AWS_SES_SOURCE_ARN?.trim() || undefined,
    klaviyoMailEventEnabled: parseBooleanish(
      process.env.KLAVIYO_MAIL_EVENT_ENABLED
    ),
    klaviyoPrivateApiKey:
      process.env.KLAVIYO_PRIVATE_API_KEY?.trim() || undefined,
    klaviyoApiRevision:
      process.env.KLAVIYO_API_REVISION?.trim() || undefined,
    klaviyoMailEventMetricName:
      process.env.KLAVIYO_MAIL_EVENT_METRIC_NAME?.trim() || undefined,
    klaviyoMailEventAllowedTemplateSlugs:
      process.env.KLAVIYO_MAIL_EVENT_ALLOWED_TEMPLATE_SLUGS?.trim() ||
      undefined,
    klaviyoMailEventTimeoutMs:
      process.env.KLAVIYO_MAIL_EVENT_TIMEOUT_MS || undefined,
  };
}

export function getMailerEnv(): MailerEnv {
  if (!cachedMailerEnv) {
    cachedMailerEnv = mailerEnvSchema.parse(buildMailerEnvInput());
  }
  return cachedMailerEnv;
}

function getRequiredKeysForProvider(provider: MailProviderKey): string[] {
  switch (provider) {
    case "AWS_SES":
      return ["AWS_SES_REGION"];
    case "SMTP":
      return [
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_SECURE",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
      ];
    case "SENDGRID":
      return ["MAIL_PROVIDER_API_KEY"];
    case "RESEND":
      return ["MAIL_PROVIDER_API_KEY"];
    default:
      return [];
  }
}

export function getMissingProviderConfigKeys(env: MailerEnv) {
  const missing: string[] = [];

  for (const key of getRequiredKeysForProvider(env.provider)) {
    switch (key) {
      case "AWS_SES_REGION":
        if (!env.sesRegion) missing.push(key);
        break;
      case "SMTP_HOST":
        if (!env.smtpHost) missing.push(key);
        break;
      case "SMTP_PORT":
        if (!env.smtpPort) missing.push(key);
        break;
      case "SMTP_SECURE":
        if (typeof env.smtpSecure !== "boolean") missing.push(key);
        break;
      case "SMTP_USERNAME":
        if (!env.smtpUsername) missing.push(key);
        break;
      case "SMTP_PASSWORD":
        if (!env.smtpPassword) missing.push(key);
        break;
      case "MAIL_PROVIDER_API_KEY":
        if (!process.env.MAIL_PROVIDER_API_KEY?.trim()) missing.push(key);
        break;
      default:
        break;
    }
  }

  return missing;
}

export function getMailerEnvSummary(): MailerEnvSummary {
  const env = getMailerEnv();
  const missing: string[] = [];

  if (!env.fromEmail) missing.push("MAIL_FROM_EMAIL");
  if (!env.recaptchaSiteKey) missing.push("MAIL_RECAPTCHA_SITE_KEY");
  if (!env.recaptchaSecretKey) missing.push("MAIL_RECAPTCHA_SECRET_KEY");

  for (const key of getMissingProviderConfigKeys(env)) {
    if (!missing.includes(key)) {
      missing.push(key);
    }
  }

  const runtimeIssue = getMailProviderRuntimeIssue(env.provider);
  const envConfigured = missing.length === 0;
  const runtimeReady = runtimeIssue == null;

  return {
    provider: env.provider,
    envConfigured,
    runtimeReady,
    configured: envConfigured && runtimeReady,
    missing,
    runtimeIssue,
    recaptcha: {
      enabled: Boolean(env.recaptchaSiteKey && env.recaptchaSecretKey),
      action: env.recaptchaAction,
      threshold: env.recaptchaThreshold,
    },
    providerSettings: {
      apiKeyConfigured: Boolean(process.env.MAIL_PROVIDER_API_KEY?.trim()),
      sesRegion: env.sesRegion || null,
      sesConfigurationSetConfigured: Boolean(env.sesConfigurationSet),
      sesSourceArnConfigured: Boolean(env.sesSourceArn),
      smtpHost: env.smtpHost || null,
      smtpPort: env.smtpPort ?? null,
      smtpSecure:
        typeof env.smtpSecure === "boolean" ? env.smtpSecure : null,
      smtpUsernameConfigured: Boolean(env.smtpUsername),
      smtpPasswordConfigured: Boolean(env.smtpPassword),
    },
    attachmentPolicy: {
      maxAttachmentBytes: env.maxAttachmentBytes,
      maxTemplateAttachmentCount: env.maxTemplateAttachmentCount,
      maxTotalAttachmentBytes: env.maxTotalAttachmentBytes,
    },
    rateLimits: {
      emailPer10Min: env.emailRateLimitPer10Min,
      ipPer10Min: env.ipRateLimitPer10Min,
      templatePerHour: env.templateRateLimitPerHour,
    },
    retention: {
      logRetentionDays: env.logRetentionDays,
    },
    klaviyoMailEvents: {
      enabled: env.klaviyoMailEventEnabled,
      apiKeyConfigured: Boolean(env.klaviyoPrivateApiKey),
      apiRevision: env.klaviyoApiRevision,
      metricName: env.klaviyoMailEventMetricName,
      allowedTemplateSlugs: env.klaviyoMailEventAllowedTemplateSlugs,
      timeoutMs: env.klaviyoMailEventTimeoutMs,
    },
  };
}

export function resetMailerEnvForTests() {
  cachedMailerEnv = null;
}
