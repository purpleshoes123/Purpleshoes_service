import { getCouponRedisClient } from "~/domains/coupons/redisClient";
import { memoryDel, memoryGet, memorySet } from "~/domains/coupons/memoryStore";
import { extractCustomerIdNumeric } from "./customerId";

const DEFAULT_TTL_SECONDS = 60;

function cacheKey(customerId: string): string | null {
  const numeric = extractCustomerIdNumeric(customerId);
  if (!numeric) {
    return null;
  }
  return `coupon:cache:tour15Balance:${numeric}`;
}

export async function getCachedTour15Balance(customerId: string): Promise<number | null> {
  const key = cacheKey(customerId);
  if (!key) {
    return null;
  }
  const client = getCouponRedisClient();
  const raw = client ? await client.get(key) : memoryGet(key);
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function setCachedTour15Balance(
  customerId: string,
  balance: number,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const key = cacheKey(customerId);
  if (!key) {
    return;
  }
  const value = String(Math.max(0, Math.trunc(balance)));
  const client = getCouponRedisClient();
  if (client) {
    await client.set(key, value, "EX", ttlSeconds);
    return;
  }
  memorySet(key, value, ttlSeconds);
}

export async function clearCachedTour15Balance(customerId: string): Promise<void> {
  const key = cacheKey(customerId);
  if (!key) {
    return;
  }
  const client = getCouponRedisClient();
  if (client) {
    await client.del(key);
    return;
  }
  memoryDel(key);
}
