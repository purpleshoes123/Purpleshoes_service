import { getMailerEnv, type MailerEnv } from "~/domains/mail/env";
import { maskEmail } from "~/lib/masking";

const KLAVIYO_EVENTS_ENDPOINT = "https://a.klaviyo.com/api/events";
const ADMIN_TEST_REQUEST_SOURCE = "ADMIN_TEST";
export const KLAVIYO_ACCOUNT_REGISTERED_METRIC_NAME = "Purple Shoes Web Registration Verified";

type KlaviyoFetch = typeof fetch;

export type KlaviyoMailEventInput = {
  sendRequestId: string;
  shopDomain: string;
  templateSlug: string | null;
  templateName: string | null;
  recipientEmail: string;
  recipientName?: string | null;
  customerId?: string | null;
  requestSource: string;
  emailProvider: string;
  providerMessageId?: string | null;
  sentAt: string;
  pagePath?: string | null;
};

export type KlaviyoAccountRegistrationEventInput = {
  shopDomain: string;
  customerId: string;
  recipientEmail: string;
  recipientName?: string | null;
  registeredAt: string;
};

type KlaviyoMailEventSkipReason =
  | "disabled"
  | "missing_api_key"
  | "missing_template_slug"
  | "missing_recipient_email"
  | "template_slug_not_allowed"
  | "request_source_not_allowed";

type KlaviyoMailEventResult =
  | {
      status: "SKIPPED";
      reason: KlaviyoMailEventSkipReason;
    }
  | {
      status: "SENT";
      klaviyoStatus: number;
    }
  | {
      status: "FAILED";
      statusCode?: number;
      error: string;
    };

export class KlaviyoMailEventError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "KlaviyoMailEventError";
    this.statusCode = statusCode;
  }
}

function normalizeOptionalString(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeRecipientEmail(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function parseKlaviyoAllowedTemplateSlugs(raw: string) {
  const normalized = String(raw || "*").trim();
  if (!normalized || normalized === "*") {
    return {
      allowAll: true,
      slugs: new Set<string>(),
    };
  }

  return {
    allowAll: false,
    slugs: new Set(
      normalized
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  };
}

export function isKlaviyoTemplateSlugAllowed(raw: string, templateSlug: string) {
  const parsed = parseKlaviyoAllowedTemplateSlugs(raw);
  return parsed.allowAll || parsed.slugs.has(templateSlug);
}

export function getKlaviyoMailEventSkipReason(
  env: MailerEnv,
  input: KlaviyoMailEventInput,
): KlaviyoMailEventSkipReason | null {
  if (!env.klaviyoMailEventEnabled) {
    return "disabled";
  }

  if (!env.klaviyoPrivateApiKey) {
    return "missing_api_key";
  }

  const recipientEmail = normalizeRecipientEmail(input.recipientEmail);
  if (!recipientEmail) {
    return "missing_recipient_email";
  }

  const templateSlug = normalizeOptionalString(input.templateSlug);
  if (!templateSlug) {
    return "missing_template_slug";
  }

  if (input.requestSource === ADMIN_TEST_REQUEST_SOURCE) {
    return "request_source_not_allowed";
  }

  if (!isKlaviyoTemplateSlugAllowed(env.klaviyoMailEventAllowedTemplateSlugs, templateSlug)) {
    return "template_slug_not_allowed";
  }

  return null;
}

function compactProperties(input: Record<string, string | null>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== ""),
  );
}

export function buildKlaviyoMailEventPayload(
  env: MailerEnv,
  input: KlaviyoMailEventInput,
): Record<string, unknown> {
  const recipientEmail = normalizeRecipientEmail(input.recipientEmail);
  const templateSlug = normalizeOptionalString(input.templateSlug);
  const customerId = normalizeOptionalString(input.customerId);

  const profileAttributes: Record<string, string> = {
    email: recipientEmail,
  };
  if (customerId) {
    profileAttributes.external_id = customerId;
  }

  return {
    data: {
      type: "event",
      attributes: {
        metric: {
          data: {
            type: "metric",
            attributes: {
              name: env.klaviyoMailEventMetricName,
            },
          },
        },
        profile: {
          data: {
            type: "profile",
            attributes: profileAttributes,
          },
        },
        properties: compactProperties({
          template_slug: templateSlug,
          template_name: normalizeOptionalString(input.templateName),
          recipient_email: recipientEmail,
          send_request_id: input.sendRequestId,
          request_source: input.requestSource,
          shop_domain: input.shopDomain,
          email_provider: input.emailProvider,
          provider_message_id: normalizeOptionalString(input.providerMessageId),
          sent_at: input.sentAt,
          page_path: normalizeOptionalString(input.pagePath),
        }),
        time: input.sentAt,
        unique_id: `bta-mail:${input.sendRequestId}`,
      },
    },
  };
}

export function buildKlaviyoAccountRegistrationEventPayload(
  input: KlaviyoAccountRegistrationEventInput,
): Record<string, unknown> {
  const recipientEmail = normalizeRecipientEmail(input.recipientEmail);
  const customerId = normalizeOptionalString(input.customerId);
  const recipientName = normalizeOptionalString(input.recipientName);

  const profileAttributes: Record<string, unknown> = {
    email: recipientEmail,
    properties: { ps_web_registration_verified: true },
  };
  if (customerId) {
    profileAttributes.external_id = customerId;
  }
  if (recipientName) {
    profileAttributes.first_name = recipientName;
  }

  return {
    data: {
      type: "event",
      attributes: {
        metric: {
          data: {
            type: "metric",
            attributes: {
              name: KLAVIYO_ACCOUNT_REGISTERED_METRIC_NAME,
            },
          },
        },
        profile: {
          data: {
            type: "profile",
            attributes: profileAttributes,
          },
        },
        properties: compactProperties({
          customer_id: customerId,
          shop_domain: normalizeOptionalString(input.shopDomain),
          registered_at: normalizeOptionalString(input.registeredAt),
        }),
        time: input.registeredAt,
        unique_id: `bta-web-registration-v2:${input.shopDomain}:${customerId || recipientEmail}`,
      },
    },
  };
}

async function readKlaviyoErrorBody(response: Response) {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return "";
  }
}

export async function postKlaviyoMailEvent(params: {
  env: MailerEnv;
  payload: Record<string, unknown>;
  fetchImpl?: KlaviyoFetch;
}) {
  const fetchImpl = params.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.env.klaviyoMailEventTimeoutMs);

  try {
    const response = await fetchImpl(KLAVIYO_EVENTS_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
        Authorization: `Klaviyo-API-Key ${params.env.klaviyoPrivateApiKey}`,
        revision: params.env.klaviyoApiRevision,
      },
      body: JSON.stringify(params.payload),
    });

    if (response.status !== 202) {
      const errorBody = await readKlaviyoErrorBody(response);
      throw new KlaviyoMailEventError(
        errorBody || `Unexpected Klaviyo status ${response.status}`,
        response.status,
      );
    }

    return {
      statusCode: response.status,
    };
  } catch (error) {
    if (error instanceof KlaviyoMailEventError) {
      throw error;
    }

    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new KlaviyoMailEventError(
      isAbort
        ? `Klaviyo mail event timeout after ${params.env.klaviyoMailEventTimeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function logKlaviyoMailEventSkipped(
  input: KlaviyoMailEventInput,
  reason: KlaviyoMailEventSkipReason,
) {
  if (reason === "disabled") {
    return;
  }

  console.info(
    JSON.stringify({
      message: "Klaviyo mail event skipped",
      sendRequestId: input.sendRequestId,
      templateSlug: input.templateSlug,
      recipientEmailMasked: maskEmail(input.recipientEmail),
      reason,
    }),
  );
}

export async function sendKlaviyoMailEventForSentMail(params: {
  env: MailerEnv;
  input: KlaviyoMailEventInput;
  fetchImpl?: KlaviyoFetch;
}): Promise<KlaviyoMailEventResult> {
  const skipReason = getKlaviyoMailEventSkipReason(params.env, params.input);
  if (skipReason) {
    logKlaviyoMailEventSkipped(params.input, skipReason);
    return {
      status: "SKIPPED",
      reason: skipReason,
    };
  }

  try {
    const payload = buildKlaviyoMailEventPayload(params.env, params.input);
    const result = await postKlaviyoMailEvent({
      env: params.env,
      payload,
      fetchImpl: params.fetchImpl,
    });

    console.info(
      JSON.stringify({
        message: "Klaviyo mail event sent",
        sendRequestId: params.input.sendRequestId,
        templateSlug: params.input.templateSlug,
        recipientEmailMasked: maskEmail(params.input.recipientEmail),
        metricName: params.env.klaviyoMailEventMetricName,
        klaviyoStatus: result.statusCode,
      }),
    );

    return {
      status: "SENT",
      klaviyoStatus: result.statusCode,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Klaviyo mail event failed",
        sendRequestId: params.input.sendRequestId,
        templateSlug: params.input.templateSlug,
        recipientEmailMasked: maskEmail(params.input.recipientEmail),
        metricName: params.env.klaviyoMailEventMetricName,
        status: error instanceof KlaviyoMailEventError ? error.statusCode || null : null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return {
      status: "FAILED",
      statusCode: error instanceof KlaviyoMailEventError ? error.statusCode : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Emits a lifecycle signal without treating the transactional registration
 * thank-you email as a squeeze-flow entry event. Klaviyo can use this metric
 * as a flow filter before each scheduled reminder email.
 */
export async function sendKlaviyoAccountRegistrationEvent(params: {
  input: KlaviyoAccountRegistrationEventInput;
  env?: MailerEnv;
  fetchImpl?: KlaviyoFetch;
}) {
  const env = params.env || getMailerEnv();
  const recipientEmail = normalizeRecipientEmail(params.input.recipientEmail);

  if (!env.klaviyoMailEventEnabled || !env.klaviyoPrivateApiKey || !recipientEmail) {
    return { status: "SKIPPED" as const };
  }

  try {
    const result = await postKlaviyoMailEvent({
      env,
      payload: buildKlaviyoAccountRegistrationEventPayload(params.input),
      fetchImpl: params.fetchImpl,
    });
    console.info(
      JSON.stringify({
        message: "Klaviyo account registration event sent",
        customerId: params.input.customerId,
        recipientEmailMasked: maskEmail(recipientEmail),
        metricName: KLAVIYO_ACCOUNT_REGISTERED_METRIC_NAME,
        klaviyoStatus: result.statusCode,
      }),
    );
    return { status: "SENT" as const, klaviyoStatus: result.statusCode };
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Klaviyo account registration event failed",
        customerId: params.input.customerId,
        recipientEmailMasked: maskEmail(recipientEmail),
        metricName: KLAVIYO_ACCOUNT_REGISTERED_METRIC_NAME,
        status: error instanceof KlaviyoMailEventError ? error.statusCode || null : null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { status: "FAILED" as const };
  }
}
