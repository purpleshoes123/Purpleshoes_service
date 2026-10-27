import { getCouponRedisClient } from "./redisClient";
import { idemKey } from "./keys";
import { memorySetNxEx } from "./memoryStore";

export async function tryMarkEventOnce(
  eventType: string,
  eventId: string,
  ttlSeconds: number
): Promise<boolean> {
  const key = idemKey(eventType, eventId);
  const client = getCouponRedisClient();
  if (client) {
    const result = await client.set(key, "1", "NX", "EX", ttlSeconds);
    return result === "OK";
  }
  return memorySetNxEx(key, "1", ttlSeconds);
}
