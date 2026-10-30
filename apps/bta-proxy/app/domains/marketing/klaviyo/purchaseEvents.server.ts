import { maskEmail } from "~/lib/masking";

const KLAVIYO_EVENTS_ENDPOINT = "https://a.klaviyo.com/api/events";
const DEFAULT_API_REVISION = "2026-04-15";
const DEFAULT_TIMEOUT_MS = 3000;

type KlaviyoFetch = typeof fetch;

export type KlaviyoPurchaseEventEnv = {
  enabled: boolean;
  privateApiKey?: string;
  apiRevision: string;
  timeoutMs: number;
  logDisabled: boolean;
};

export type KlaviyoPurchaseEventKind = "GUIDE_BASE" | "GUIDE_EXTENSION" | "TOUR";

export type KlaviyoPurchaseEventOption =
  | "PDF"
  | "VIDEO"
  | "GUIDE-KIT"
  | "PDF-EX"
  | "VIDEO-EX"
  | "GUIDE-KIT-EX"
  | "TOUR";

export type KlaviyoPurchaseEventProperties = Record<string, unknown>;

export type KlaviyoPurchaseEventInput = {
  metricName: string;
  uniqueId: string;
  email: string;
  customerId?: string | null;
  eventKind: KlaviyoPurchaseEventKind;
  option: KlaviyoPurchaseEventOption;
  occurredAt: string;
  properties: KlaviyoPurchaseEventProperties;
};

type KlaviyoPurchaseEventSkipReason =
  | "disabled"
  | "missing_api_key"
  | "missing_email"
  | "missing_metric_name"
  | "missing_unique_id";

export type KlaviyoPurchaseEventResult =
  | {
      status: "SKIPPED";
      reason: KlaviyoPurchaseEventSkipReason;
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

export class KlaviyoPurchaseEventError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "KlaviyoPurchaseEventError";
    this.statusCode = statusCode;
  }
}

let cachedEnv: KlaviyoPurchaseEventEnv | null = null;

function parseBooleanish(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeOptionalString(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function resetKlaviyoPurchaseEventEnvForTests(): void {
  cachedEnv = null;
}

export function getKlaviyoPurchaseEventEnv(): KlaviyoPurchaseEventEnv {
  if (cachedEnv) {
    return cachedEnv;
  }
  cachedEnv = {
    enabled: parseBooleanish(process.env.KLAVIYO_PURCHASE_EVENT_ENABLED, false),
    privateApiKey: process.env.KLAVIYO_PRIVATE_API_KEY?.trim() || undefined,
    apiRevision: process.env.KLAVIYO_API_REVISION?.trim() || DEFAULT_API_REVISION,
    timeoutMs: parsePositiveInteger(
      process.env.KLAVIYO_PURCHASE_EVENT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    logDisabled: parseBooleanish(process.env.KLAVIYO_PURCHASE_EVENT_LOG_DISABLED, false),
  };
  return cachedEnv;
}

export function getKlaviyoPurchaseEventSkipReason(
  env: KlaviyoPurchaseEventEnv,
  input: KlaviyoPurchaseEventInput,
): KlaviyoPurchaseEventSkipReason | null {
  if (!env.enabled) {
    return "disabled";
  }
  if (!env.privateApiKey) {
    return "missing_api_key";
  }
  if (!normalizeEmail(input.email)) {
    return "missing_email";
  }
  if (!normalizeOptionalString(input.metricName)) {
    return "missing_metric_name";
  }
  if (!normalizeOptionalString(input.uniqueId)) {
    return "missing_unique_id";
  }
  return null;
}

function compactProperties(input: KlaviyoPurchaseEventProperties) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === null || value === undefined) {
        return false;
      }
      if (typeof value === "string" && value.trim() === "") {
        return false;
      }
      if (Array.isArray(value) && value.length === 0) {
        return false;
      }
      return true;
    }),
  );
}

export function buildKlaviyoPurchaseEventPayload(
  input: KlaviyoPurchaseEventInput,
): Record<string, unknown> {
  const email = normalizeEmail(input.email);
  const customerId = normalizeOptionalString(input.customerId);
  const profileAttributes: Record<string, string> = { email };
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
              name: input.metricName,
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
          ...input.properties,
          event_kind: input.eventKind,
          option: input.option,
          customer_email: email,
          customer_id: customerId,
        }),
        time: input.occurredAt,
        unique_id: input.uniqueId,
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

export async function postKlaviyoPurchaseEvent(params: {
  env: KlaviyoPurchaseEventEnv;
  payload: Record<string, unknown>;
  fetchImpl?: KlaviyoFetch;
}) {
  const fetchImpl = params.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.env.timeoutMs);

  try {
    const response = await fetchImpl(KLAVIYO_EVENTS_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
        Authorization: `Klaviyo-API-Key ${params.env.privateApiKey}`,
        revision: params.env.apiRevision,
      },
      body: JSON.stringify(params.payload),
    });

    if (response.status !== 202) {
      const errorBody = await readKlaviyoErrorBody(response);
      throw new KlaviyoPurchaseEventError(
        errorBody || `Unexpected Klaviyo status ${response.status}`,
        response.status,
      );
    }

    return { statusCode: response.status };
  } catch (error) {
    if (error instanceof KlaviyoPurchaseEventError) {
      throw error;
    }

    const isAbort = error instanceof Error && error.name === "AbortError";
    throw new KlaviyoPurchaseEventError(
      isAbort
        ? `Klaviyo purchase event timeout after ${params.env.timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function logSkipped(
  env: KlaviyoPurchaseEventEnv,
  input: KlaviyoPurchaseEventInput,
  reason: KlaviyoPurchaseEventSkipReason,
) {
  if (reason === "disabled" && !env.logDisabled) {
    return;
  }
  console.info(
    JSON.stringify({
      message: "Klaviyo purchase event skipped",
      metricName: input.metricName,
      eventKind: input.eventKind,
      option: input.option,
      uniqueId: input.uniqueId,
      emailMasked: maskEmail(input.email),
      reason,
    }),
  );
}

export async function sendKlaviyoPurchaseEvent(params: {
  env?: KlaviyoPurchaseEventEnv;
  input: KlaviyoPurchaseEventInput;
  fetchImpl?: KlaviyoFetch;
}): Promise<KlaviyoPurchaseEventResult> {
  const env = params.env || getKlaviyoPurchaseEventEnv();
  const skipReason = getKlaviyoPurchaseEventSkipReason(env, params.input);
  if (skipReason) {
    logSkipped(env, params.input, skipReason);
    return { status: "SKIPPED", reason: skipReason };
  }

  try {
    const payload = buildKlaviyoPurchaseEventPayload(params.input);
    const result = await postKlaviyoPurchaseEvent({
      env,
      payload,
      fetchImpl: params.fetchImpl,
    });
    console.info(
      JSON.stringify({
        message: "Klaviyo purchase event sent",
        metricName: params.input.metricName,
        eventKind: params.input.eventKind,
        option: params.input.option,
        uniqueId: params.input.uniqueId,
        emailMasked: maskEmail(params.input.email),
        klaviyoStatus: result.statusCode,
      }),
    );
    return { status: "SENT", klaviyoStatus: result.statusCode };
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Klaviyo purchase event failed",
        metricName: params.input.metricName,
        eventKind: params.input.eventKind,
        option: params.input.option,
        uniqueId: params.input.uniqueId,
        emailMasked: maskEmail(params.input.email),
        status: error instanceof KlaviyoPurchaseEventError ? error.statusCode || null : null,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      status: "FAILED",
      statusCode: error instanceof KlaviyoPurchaseEventError ? error.statusCode : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
