import {
  DEFAULT_MAIL_PROVIDER,
  MAILER_PROVIDER_KEYS,
  type MailProviderKey,
} from "~/domains/mail/contracts";

export const IMPLEMENTED_MAIL_PROVIDER_KEYS = [
  "AWS_SES",
  "SMTP",
] as const satisfies readonly MailProviderKey[];

export type MailSendAddress = {
  email: string;
  name?: string | null;
};

export type MailSendAttachment = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
};

export type MailSendInput = {
  disableAutomaticRetries?: boolean;
  from: MailSendAddress;
  recipient: MailSendAddress;
  subject: string;
  htmlBody?: string | null;
  textBody?: string | null;
  replyTo?: string | null;
  attachments?: MailSendAttachment[];
  metadata?: Record<string, string>;
};

export type MailSendResult = {
  provider: MailProviderKey;
  messageId: string;
  acceptedAt: string;
};

export type MailProviderConnectionCheckResult = {
  provider: MailProviderKey;
  checkedAt: string;
  detail: string;
};

export interface MailProvider {
  readonly key: MailProviderKey;
  send(input: MailSendInput): Promise<MailSendResult>;
}

export class MailProviderNotImplementedError extends Error {
  provider: MailProviderKey;

  constructor(provider: MailProviderKey) {
    super(`${provider} provider integration is not implemented yet.`);
    this.name = "MailProviderNotImplementedError";
    this.provider = provider;
  }
}

export class MailProviderTimeoutError extends Error {
  provider: MailProviderKey;

  constructor(provider: MailProviderKey, message?: string) {
    super(message || `${provider} send timeout`);
    this.name = "MailProviderTimeoutError";
    this.provider = provider;
  }
}

export function isMailProviderKey(value: string): value is MailProviderKey {
  return (MAILER_PROVIDER_KEYS as readonly string[]).includes(value);
}

export function resolveMailProviderKey(raw?: string | null): MailProviderKey {
  const normalized = String(raw || "")
    .trim()
    .toUpperCase();
  return isMailProviderKey(normalized) ? normalized : DEFAULT_MAIL_PROVIDER;
}

export function isImplementedMailProviderKey(
  value: MailProviderKey,
): value is (typeof IMPLEMENTED_MAIL_PROVIDER_KEYS)[number] {
  return (IMPLEMENTED_MAIL_PROVIDER_KEYS as readonly string[]).includes(value);
}

export function getMailProviderRuntimeIssue(provider: MailProviderKey) {
  return isImplementedMailProviderKey(provider) ? null : `${provider} provider runtime`;
}

export function createMailProviderScaffold(key: MailProviderKey): MailProvider {
  return {
    key,
    async send() {
      throw new MailProviderNotImplementedError(key);
    },
  };
}
