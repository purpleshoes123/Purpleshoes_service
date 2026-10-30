import { createRequire } from "module";

const require = createRequire(import.meta.url);

let cachedClient: any | null = null;
let warned = false;

export function getCouponRedisClient(): any | null {
  const multiNode = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
  if (multiNode && !process.env.REDIS_URL) {
    throw new Error("Multi-node coupons require shared Redis; memory fallback is disabled.");
  }
  if (cachedClient) {
    return cachedClient;
  }

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
    if (multiNode) {
      throw new Error("Shared coupon store initialization failed; memory fallback is disabled.");
    }
    if (!warned) {
      warned = true;
      console.warn(
        JSON.stringify({
          message: "Redis connection failed for coupons; falling back to memory store",
        }),
      );
    }
    cachedClient = null;
    return null;
  }
}
