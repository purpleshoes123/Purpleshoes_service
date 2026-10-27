import { createRequire } from "module";

const require = createRequire(import.meta.url);

export type RateLimitStoreName = "redis" | "memory";

export interface RateLimitCounterResult {
  count: number;
  ttlMs: number;
}

export interface RateLimitCounterStore {
  readonly name: RateLimitStoreName;
  increment(key: string, windowMs: number): Promise<RateLimitCounterResult>;
}

type RedisEvalClient = {
  readonly status?: string;
  ping?(): Promise<unknown>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
};

const INCREMENT_WITH_TTL_SCRIPT = `
  local count = redis.call("INCR", KEYS[1])
  local ttl = redis.call("PTTL", KEYS[1])

  if count == 1 or ttl < 0 then
    redis.call("PEXPIRE", KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end

  return { count, ttl }
`;

/**
 * Fixed-window counter used only when Redis is unavailable. The caller passes
 * a hashed key, so customer identifiers are not retained in process memory.
 */
export class InMemoryRateLimitCounterStore implements RateLimitCounterStore {
  readonly name = "memory" as const;

  private readonly entries = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  async increment(
    key: string,
    windowMs: number,
  ): Promise<RateLimitCounterResult> {
    const now = this.now();
    const entry = this.entries.get(key);

    if (!entry || entry.resetAt <= now) {
      const resetAt = now + windowMs;
      this.entries.set(key, { count: 1, resetAt });
      return { count: 1, ttlMs: windowMs };
    }

    entry.count += 1;
    return {
      count: entry.count,
      ttlMs: Math.max(0, entry.resetAt - now),
    };
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Redis's INCR and PEXPIRE must run atomically: an interrupted request must
 * not leave a counter without a TTL and permanently rate-limit a customer.
 */
export class RedisRateLimitCounterStore implements RateLimitCounterStore {
  readonly name = "redis" as const;
  private readonly client: RedisEvalClient;

  constructor(client: RedisEvalClient) {
    this.client = client;
  }

  async isReady(): Promise<boolean> {
    // Do not queue probes or consume customer rate-limit counters.
    if (this.client.status !== "ready" || !this.client.ping) return false;
    try {
      return await this.client.ping() === "PONG";
    } catch {
      return false;
    }
  }

  async increment(
    key: string,
    windowMs: number,
  ): Promise<RateLimitCounterResult> {
    const raw = await this.client.eval(
      INCREMENT_WITH_TTL_SCRIPT,
      1,
      key,
      windowMs,
    );
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error("Invalid Redis rate limit counter result");
    }

    const count = Number(raw[0]);
    const ttlMs = Number(raw[1]);
    if (!Number.isSafeInteger(count) || count < 1 ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > windowMs) {
      throw new Error("Invalid Redis rate limit counter values");
    }

    return { count, ttlMs };
  }
}

let cachedRedisStore: RedisRateLimitCounterStore | null | undefined;
let cachedRedisUrl: string | undefined;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Returns null when Redis is not configured. Connection and command timeouts
 * are deliberately short. Multi-node callers fail closed if Redis is unavailable;
 * readiness must warm this separate connection before receiving user traffic.
 */
export function getRedisRateLimitCounterStore(): RedisRateLimitCounterStore | null {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  if (cachedRedisUrl === redisUrl && cachedRedisStore !== undefined) {
    return cachedRedisStore;
  }

  cachedRedisUrl = redisUrl;

  try {
    const timeoutMs = positiveInteger(
      process.env.STOREFRONT_RATE_LIMIT_REDIS_TIMEOUT_MS,
      300,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    const client = new Redis(redisUrl, {
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: (attempt: number) =>
        Math.min(500, Math.max(50, attempt * 50)),
    });

    // ioredis emits connection errors through EventEmitter. A listener keeps
    // those recoverable errors from becoming unhandled process-level errors.
    client.on("error", () => undefined);
    cachedRedisStore = new RedisRateLimitCounterStore(client);
    return cachedRedisStore;
  } catch {
    cachedRedisStore = null;
    return null;
  }
}

/** Test-only reset for the cached process client. */
export function resetRedisRateLimitCounterStoreForTests(): void {
  cachedRedisStore = undefined;
  cachedRedisUrl = undefined;
}

export { INCREMENT_WITH_TTL_SCRIPT };
