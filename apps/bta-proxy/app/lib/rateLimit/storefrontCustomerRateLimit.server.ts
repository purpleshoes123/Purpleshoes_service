import { createHash } from "crypto";
import { ErrorCode } from "~/lib/errors";
import { respond } from "~/lib/respond";
import {
  getRedisRateLimitCounterStore,
  InMemoryRateLimitCounterStore,
  type RateLimitCounterStore,
  type RateLimitStoreName,
} from "./rateLimitStore.server";

export type StorefrontRateLimitMode = "off" | "observe" | "enforce";
export type StorefrontRateLimitBucket = "mypage-read" | "signed-url" | "mypage-write";

export interface StorefrontRateLimitDecision {
  allowed: boolean;
  bucket: StorefrontRateLimitBucket;
  limit: number;
  count: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
  store: RateLimitStoreName;
  mode: Exclude<StorefrontRateLimitMode, "off">;
  identityFingerprint: string;
}

export interface StorefrontRateLimitConfig {
  mode: StorefrontRateLimitMode;
  windowMs: number;
  limits: Record<StorefrontRateLimitBucket, number>;
  redisTimeoutMs: number;
  circuitCooldownMs: number;
}

export interface StorefrontCustomerRateLimiter {
  check(input: {
    shop: string;
    customerId: string;
    bucket: StorefrontRateLimitBucket;
  }): Promise<StorefrontRateLimitDecision>;
}

const DEFAULT_WINDOW_SEC = 60;
const DEFAULT_LIMITS: Record<StorefrontRateLimitBucket, number> = {
  "mypage-read": 120,
  "signed-url": 20,
  "mypage-write": 30,
};

const invalidEnvironmentWarnings = new Set<string>();

function warnInvalidEnvironment(
  name: string,
  rawValue: string | undefined,
  fallback: string,
): void {
  if (!rawValue || invalidEnvironmentWarnings.has(name)) {
    return;
  }
  invalidEnvironmentWarnings.add(name);
  console.warn(
    JSON.stringify({
      message: "Invalid storefront rate limit environment value; using default",
      name,
      fallback,
    }),
  );
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const rawValue = process.env[name];
  const parsed = Number(rawValue);
  if (rawValue === undefined || (Number.isSafeInteger(parsed) && parsed > 0)) {
    return rawValue === undefined ? fallback : parsed;
  }
  warnInvalidEnvironment(name, rawValue, String(fallback));
  return fallback;
}

export function getStorefrontRateLimitMode(): StorefrontRateLimitMode {
  if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
    return "enforce";
  }
  const rawValue = process.env.STOREFRONT_RATE_LIMIT_V2_MODE;
  if (rawValue === undefined || rawValue.trim() === "") {
    return "off";
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "off" || normalized === "observe" || normalized === "enforce") {
    return normalized;
  }

  warnInvalidEnvironment("STOREFRONT_RATE_LIMIT_V2_MODE", rawValue, "off");
  return "off";
}

export function getStorefrontRateLimitConfig(): StorefrontRateLimitConfig {
  return {
    mode: getStorefrontRateLimitMode(),
    windowMs:
      positiveIntegerEnvironment("STOREFRONT_RATE_LIMIT_WINDOW_SEC", DEFAULT_WINDOW_SEC) * 1000,
    limits: {
      "mypage-read": positiveIntegerEnvironment(
        "STOREFRONT_RATE_LIMIT_MYPAGE_READ_PER_MIN",
        DEFAULT_LIMITS["mypage-read"],
      ),
      "signed-url": positiveIntegerEnvironment(
        "STOREFRONT_RATE_LIMIT_SIGNED_URL_PER_MIN",
        DEFAULT_LIMITS["signed-url"],
      ),
      "mypage-write": positiveIntegerEnvironment(
        "STOREFRONT_RATE_LIMIT_MYPAGE_WRITE_PER_MIN",
        DEFAULT_LIMITS["mypage-write"],
      ),
    },
    redisTimeoutMs: positiveIntegerEnvironment("STOREFRONT_RATE_LIMIT_REDIS_TIMEOUT_MS", 300),
    circuitCooldownMs: positiveIntegerEnvironment(
      "STOREFRONT_RATE_LIMIT_REDIS_CIRCUIT_COOLDOWN_MS",
      15000,
    ),
  };
}

export function getStorefrontCustomerIdentityFingerprint(shop: string, customerId: string): string {
  return createHash("sha256").update(`${shop}\0${customerId}`, "utf8").digest("hex");
}

export function buildStorefrontRateLimitKey(input: {
  mode: Exclude<StorefrontRateLimitMode, "off">;
  bucket: StorefrontRateLimitBucket;
  identityFingerprint: string;
}): string {
  return `bta:rate-limit:v2:${input.mode}:${input.bucket}:${input.identityFingerprint}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Redis rate limit command timed out")), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export function createStorefrontCustomerRateLimiter(
  options: {
    now?: () => number;
    getConfig?: () => StorefrontRateLimitConfig;
    getRedisStore?: () => RateLimitCounterStore | null;
    memoryStore?: RateLimitCounterStore;
    warn?: (entry: Record<string, unknown>) => void;
  } = {},
): StorefrontCustomerRateLimiter {
  const now = options.now ?? (() => Date.now());
  const getConfig = options.getConfig ?? getStorefrontRateLimitConfig;
  const getRedisStore = options.getRedisStore ?? getRedisRateLimitCounterStore;
  const memoryStore = options.memoryStore ?? new InMemoryRateLimitCounterStore(now);
  const warn = options.warn ?? ((entry) => console.warn(JSON.stringify(entry)));

  let circuitOpenUntil = 0;
  let probeInFlight = false;
  let lastFallbackWarningAt = 0;

  function warnFallback(
    input: {
      bucket: StorefrontRateLimitBucket;
      identityFingerprint: string;
    },
    cooldownMs: number,
  ): void {
    const current = now();
    if (current - lastFallbackWarningAt < cooldownMs) {
      return;
    }
    lastFallbackWarningAt = current;
    warn({
      message: "Storefront customer rate limiter using memory fallback",
      bucket: input.bucket,
      identityFingerprint: input.identityFingerprint.slice(0, 12),
      error: "Shared counter unavailable",
    });
  }

  async function increment(
    key: string,
    input: { bucket: StorefrontRateLimitBucket; identityFingerprint: string },
    config: StorefrontRateLimitConfig,
  ): Promise<{
    result: { count: number; ttlMs: number };
    store: RateLimitStoreName;
  }> {
    const redisStore = getRedisStore();
    const current = now();
    const circuitOpen = circuitOpenUntil > current;
    const isProbe = circuitOpenUntil > 0 && !circuitOpen;
    const multiNode = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";

    if (!redisStore || circuitOpen || (isProbe && probeInFlight)) {
      if (multiNode) {
        throw new Error("Shared rate limiter unavailable");
      }
      return {
        result: await memoryStore.increment(key, config.windowMs),
        store: "memory",
      };
    }

    if (isProbe) {
      probeInFlight = true;
    }
    try {
      const result = await withTimeout(
        redisStore.increment(key, config.windowMs),
        config.redisTimeoutMs,
      );
      circuitOpenUntil = 0;
      return { result, store: "redis" };
    } catch {
      circuitOpenUntil = now() + config.circuitCooldownMs;
      if (multiNode) {
        throw new Error("Shared rate limiter unavailable");
      }
      warnFallback(input, config.circuitCooldownMs);
      return {
        result: await memoryStore.increment(key, config.windowMs),
        store: "memory",
      };
    } finally {
      if (isProbe) {
        probeInFlight = false;
      }
    }
  }

  return {
    async check(input) {
      const config = getConfig();
      if (config.mode === "off") {
        throw new Error("Storefront customer rate limiter must not run in off mode");
      }

      const identityFingerprint = getStorefrontCustomerIdentityFingerprint(
        input.shop,
        input.customerId,
      );
      const key = buildStorefrontRateLimitKey({
        mode: config.mode,
        bucket: input.bucket,
        identityFingerprint,
      });
      const { result, store } = await increment(key, { ...input, identityFingerprint }, config);
      const limit = config.limits[input.bucket];
      const ttlMs = Math.max(0, result.ttlMs);
      const resetAt = now() + ttlMs;
      const allowed = result.count <= limit;

      return {
        allowed,
        bucket: input.bucket,
        limit,
        count: result.count,
        remaining: Math.max(0, limit - result.count),
        resetAt,
        retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil(ttlMs / 1000)),
        store,
        mode: config.mode,
        identityFingerprint: identityFingerprint.slice(0, 12),
      };
    },
  };
}

const defaultStorefrontCustomerRateLimiter = createStorefrontCustomerRateLimiter();

/**
 * Checks the v2 customer bucket after App Proxy signature/customer validation.
 * Observe mode intentionally counts and logs but never returns a 429 response.
 */
export async function enforceStorefrontCustomerRateLimit(input: {
  shop: string;
  customerId: string;
  bucket: StorefrontRateLimitBucket;
  path: string;
  correlationId: string;
}): Promise<Response | void> {
  const mode = getStorefrontRateLimitMode();
  if (mode === "off") {
    return;
  }

  let decision: StorefrontRateLimitDecision;
  try {
    decision = await defaultStorefrontCustomerRateLimiter.check({
      shop: input.shop,
      customerId: input.customerId,
      bucket: input.bucket,
    });
  } catch {
    const response = respond.fail(
      ErrorCode.INTERNAL_ERROR,
      "Service temporarily unavailable. Please try again shortly.",
      undefined,
      503,
      input.correlationId,
    );
    response.headers.set("Retry-After", "5");
    return respond.withNoStore(response);
  }

  if (!decision.allowed) {
    console.warn(
      JSON.stringify({
        message: "Storefront customer rate limit exceeded",
        wouldBlock: mode === "observe",
        bucket: decision.bucket,
        count: decision.count,
        limit: decision.limit,
        retryAfterSec: decision.retryAfterSec,
        store: decision.store,
        identityFingerprint: decision.identityFingerprint,
        path: input.path,
        correlationId: input.correlationId,
        shop: input.shop,
      }),
    );
  }

  if (mode === "observe" || decision.allowed) {
    return;
  }

  const response = respond.fail(
    ErrorCode.RATE_LIMITED,
    "요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.",
    {
      bucket: decision.bucket,
      retryAfterSec: decision.retryAfterSec,
    },
    429,
    input.correlationId,
  );
  response.headers.set("Retry-After", String(decision.retryAfterSec));
  response.headers.set("X-RateLimit-Limit", String(decision.limit));
  response.headers.set("X-RateLimit-Remaining", String(decision.remaining));
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
  return respond.withNoStore(response);
}
