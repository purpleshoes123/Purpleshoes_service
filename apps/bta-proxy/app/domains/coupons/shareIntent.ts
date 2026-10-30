import { getCouponRedisClient } from "./redisClient";
import { shareIntentKey } from "./keys";
import { memoryGet, memorySet } from "./memoryStore";

export async function setShareIntent(
  shareEventId: string,
  customerId: string,
  ttlSeconds: number,
): Promise<void> {
  const key = shareIntentKey(shareEventId);
  const client = getCouponRedisClient();
  if (client) {
    await client.set(key, customerId, "EX", ttlSeconds);
    return;
  }
  memorySet(key, customerId, ttlSeconds);
}

export async function getShareIntentCustomerId(shareEventId: string): Promise<string | null> {
  const key = shareIntentKey(shareEventId);
  const client = getCouponRedisClient();
  if (client) {
    return await client.get(key);
  }
  return memoryGet(key);
}
