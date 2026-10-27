import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";
import { getMailerEnv } from "~/lib/mailer/env";
import {
  MailProviderNotImplementedError,
  type MailProviderConnectionCheckResult,
  MailProviderTimeoutError,
  type MailProvider,
  type MailSendAddress,
  type MailSendInput,
  type MailSendResult,
} from "~/lib/mailer/provider";

const SES_SEND_TIMEOUT_MS = 15000;
const SMTP_CONNECT_TIMEOUT_MS = 15000;
const SMTP_VERIFY_TIMEOUT_MS = 15000;
const SMTP_SOCKET_TIMEOUT_MS = 60000;

const sesClientCache = new Map<string, SESv2Client>();

function getSesClient(region: string, disableAutomaticRetries = false) {
  const key = `${region}:${disableAutomaticRetries}`;
  if (!sesClientCache.has(key)) {
    sesClientCache.set(
      key,
      new SESv2Client({
        region,
        ...(disableAutomaticRetries ? { maxAttempts: 1 } : {}),
      })
    );
  }

  return sesClientCache.get(key)!;
}

function formatMailbox(address: MailSendAddress) {
  if (!address.name) return address.email;
  const normalizedName = address.name.replaceAll('"', "").trim();
  return normalizedName
    ? `"${normalizedName}" <${address.email}>`
    : address.email;
}

function normalizeEmailTagPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256) || "value";
}

function normalizeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 512);
}

function isTimeoutLikeError(error: unknown) {
  if (error instanceof MailProviderTimeoutError) return true;
  if (!(error instanceof Error)) return false;

  const code = String((error as NodeJS.ErrnoException).code || "")
    .trim()
    .toLowerCase();
  const message = error.message.toLowerCase();

  return (
    code === "etimedout" ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

function buildSesSendInput(input: MailSendInput): SendEmailCommandInput {
  const env = getMailerEnv();

  if (!env.sesRegion) {
    throw new Error("AWS_SES_REGION is required.");
  }

  if (!input.htmlBody && !input.textBody) {
    throw new Error("Either htmlBody or textBody is required.");
  }

  return {
    FromEmailAddress: formatMailbox(input.from),
    Destination: {
      ToAddresses: [input.recipient.email],
    },
    ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
    Content: {
      Simple: {
        Subject: {
          Data: input.subject,
          Charset: "UTF-8",
        },
        Body: {
          ...(input.htmlBody
            ? {
                Html: {
                  Data: input.htmlBody,
                  Charset: "UTF-8",
                },
              }
            : {}),
          ...(input.textBody
            ? {
                Text: {
                  Data: input.textBody,
                  Charset: "UTF-8",
                },
              }
            : {}),
        },
        ...(input.attachments?.length
          ? {
              Attachments: input.attachments.map((attachment) => ({
                RawContent: Buffer.from(attachment.contentBase64, "base64"),
                FileName: attachment.fileName,
                ContentType: attachment.mimeType,
                ContentDisposition: "ATTACHMENT",
                ContentTransferEncoding: "BASE64",
              })),
            }
          : {}),
      },
    },
    ...(env.sesConfigurationSet
      ? {
          ConfigurationSetName: env.sesConfigurationSet,
        }
      : {}),
    ...(env.sesSourceArn
      ? {
          FromEmailAddressIdentityArn: env.sesSourceArn,
        }
      : {}),
    ...(input.metadata
      ? {
          EmailTags: Object.entries(input.metadata).map(([key, value]) => ({
            Name: normalizeEmailTagPart(key),
            Value: normalizeEmailTagPart(value),
          })),
        }
      : {}),
  };
}

async function sendWithSes(input: MailSendInput): Promise<MailSendResult> {
  const env = getMailerEnv();

  if (!env.sesRegion) {
    throw new Error("AWS_SES_REGION is required.");
  }

  const client = getSesClient(env.sesRegion, input.disableAutomaticRetries);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await Promise.race([
      client.send(new SendEmailCommand(buildSesSendInput(input))),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new MailProviderTimeoutError("AWS_SES", "SES send timeout"));
        }, SES_SEND_TIMEOUT_MS);
      }),
    ]);

    return {
      provider: "AWS_SES",
      messageId: result.MessageId || "",
      acceptedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      throw new MailProviderTimeoutError(
        "AWS_SES",
        error instanceof Error ? error.message : "SES send timeout"
      );
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildSmtpTransport(options?: { socketTimeoutMs?: number }) {
  const env = getMailerEnv();

  if (!env.smtpHost) {
    throw new Error("SMTP_HOST is required.");
  }
  if (!env.smtpPort) {
    throw new Error("SMTP_PORT is required.");
  }
  if (typeof env.smtpSecure !== "boolean") {
    throw new Error("SMTP_SECURE is required.");
  }
  if (!env.smtpUsername) {
    throw new Error("SMTP_USERNAME is required.");
  }
  if (!env.smtpPassword) {
    throw new Error("SMTP_PASSWORD is required.");
  }

  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: {
      user: env.smtpUsername,
      pass: env.smtpPassword,
    },
    connectionTimeout: SMTP_CONNECT_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECT_TIMEOUT_MS,
    socketTimeout: options?.socketTimeoutMs ?? SMTP_SOCKET_TIMEOUT_MS,
  });
}

function buildSmtpSendInput(input: MailSendInput) {
  if (!input.htmlBody && !input.textBody) {
    throw new Error("Either htmlBody or textBody is required.");
  }

  return {
    from: formatMailbox(input.from),
    to: formatMailbox(input.recipient),
    subject: input.subject,
    html: input.htmlBody || undefined,
    text: input.textBody || undefined,
    replyTo: input.replyTo || undefined,
    headers: input.metadata
      ? Object.fromEntries(
          Object.entries(input.metadata).map(([key, value]) => [
            `X-BTA-Meta-${normalizeEmailTagPart(key)}`,
            normalizeHeaderValue(value),
          ])
        )
      : undefined,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.fileName,
      content: Buffer.from(attachment.contentBase64, "base64"),
      contentType: attachment.mimeType,
      contentDisposition: "attachment" as const,
    })),
  };
}

async function sendWithSmtp(input: MailSendInput): Promise<MailSendResult> {
  const transporter = buildSmtpTransport({
    socketTimeoutMs: SMTP_SOCKET_TIMEOUT_MS,
  });

  try {
    const result = await transporter.sendMail(buildSmtpSendInput(input));

    return {
      provider: "SMTP",
      messageId: result.messageId || "",
      acceptedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      throw new MailProviderTimeoutError(
        "SMTP",
        error instanceof Error ? error.message : "SMTP send timeout"
      );
    }
    throw error;
  } finally {
    transporter.close();
  }
}

export async function verifyConfiguredMailProviderConnection(): Promise<MailProviderConnectionCheckResult> {
  const env = getMailerEnv();

  if (env.provider !== "SMTP") {
    throw new MailProviderNotImplementedError(env.provider);
  }

  const transporter = buildSmtpTransport({
    socketTimeoutMs: SMTP_VERIFY_TIMEOUT_MS,
  });
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      transporter.verify(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new MailProviderTimeoutError("SMTP", "SMTP connection check timeout")
          );
        }, SMTP_VERIFY_TIMEOUT_MS);
      }),
    ]);

    return {
      provider: "SMTP",
      checkedAt: new Date().toISOString(),
      detail: `SMTP connection verified for ${env.smtpHost}:${env.smtpPort}`,
    };
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      throw new MailProviderTimeoutError(
        "SMTP",
        error instanceof Error ? error.message : "SMTP connection check timeout"
      );
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    transporter.close();
  }
}

export function getServerMailProvider(): MailProvider {
  const env = getMailerEnv();

  if (env.provider === "AWS_SES") {
    return {
      key: "AWS_SES",
      send: sendWithSes,
    };
  }

  if (env.provider === "SMTP") {
    return {
      key: "SMTP",
      send: sendWithSmtp,
    };
  }

  throw new MailProviderNotImplementedError(env.provider);
}

export async function sendMailWithConfiguredProvider(input: MailSendInput) {
  return getServerMailProvider().send(input);
}
