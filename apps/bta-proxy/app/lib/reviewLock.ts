import { createRequire } from "module";

const require = createRequire(import.meta.url);

let cachedClient: import("ioredis").Redis | null = null;
let warned = false;

const memoryLocks = new Map<string, { value: string; expiresAt: number }>();

function getRedisClient(): import("ioredis").Redis | null {
  if (cachedClient) return cachedClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    cachedClient = new Redis(redisUrl);
    return cachedClient;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(
        JSON.stringify({
          message: "Redis connection failed for review locks; falling back to memory",
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
    cachedClient = null;
    return null;
  }
}

function isMemoryLockActive(key: string): boolean {
  const entry = memoryLocks.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    memoryLocks.delete(key);
    return false;
  }
  return true;
}

export async function acquireReviewLock(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<boolean> {
  const client = getRedisClient();
  if (client) {
    try {
      const result = await client.set(key, value, "NX", "EX", ttlSeconds);
      return result === "OK";
    } catch {
      // fall through to memory lock
    }
  }

  if (isMemoryLockActive(key)) {
    return false;
  }
  memoryLocks.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  return true;
}

export async function releaseReviewLock(
  key: string,
  value: string
): Promise<void> {
  const client = getRedisClient();
  if (client) {
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await client.eval(script, 1, key, value);
      return;
    } catch {
      // fall back to memory cleanup
    }
  }
  const entry = memoryLocks.get(key);
  if (entry && entry.value === value) {
    memoryLocks.delete(key);
  }
}
