import { getCouponRedisClient } from "./redisClient";
import { lockKey } from "./keys";
import { memorySetNxEx, memoryDel } from "./memoryStore";

export async function acquireLock(
  name: string,
  customerId: string,
  ttlSeconds = 10
): Promise<boolean> {
  const key = lockKey(name, customerId);
  const client = getCouponRedisClient();
  if (client) {
    const result = await client.set(key, "1", "NX", "EX", ttlSeconds);
    return result === "OK";
  }
  return memorySetNxEx(key, "1", ttlSeconds);
}

export async function releaseLock(name: string, customerId: string): Promise<void> {
  const key = lockKey(name, customerId);
  const client = getCouponRedisClient();
  if (client) {
    await client.del(key);
    return;
  }
  memoryDel(key);
}
