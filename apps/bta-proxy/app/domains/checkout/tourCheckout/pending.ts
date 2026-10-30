import { getCouponRedisClient } from "~/domains/coupons/redisClient";
import { memoryGet, memorySet, memoryDel } from "~/domains/coupons/memoryStore";
import { normalizeCustomerId } from "~/domains/coupons/normalize";

export type TourPendingCode = {
  code: string;
  kind: "TOUR5" | "TOUR15" | "TOUR20";
  issuedAt: string;
  discountId?: string | null;
  cartId?: string | null;
  checkoutUrl?: string | null;
  prepareId?: string | null;
};

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function pendingKey(customerId: string): string {
  const normalized = normalizeCustomerId(customerId) || customerId;
  return `coupon:tour:pending:customer:${normalized}`;
}

export async function getTourPending(customerId: string): Promise<TourPendingCode | null> {
  const key = pendingKey(customerId);
  const client = getCouponRedisClient();
  const raw = client ? await client.get(key) : memoryGet(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as TourPendingCode;
  } catch {
    return null;
  }
}

export async function setTourPending(
  customerId: string,
  pending: TourPendingCode,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const key = pendingKey(customerId);
  const client = getCouponRedisClient();
  const raw = JSON.stringify(pending);
  if (client) {
    await client.set(key, raw, "EX", ttlSeconds);
    return;
  }
  memorySet(key, raw, ttlSeconds);
}

export async function clearTourPending(customerId: string): Promise<void> {
  const key = pendingKey(customerId);
  const client = getCouponRedisClient();
  if (client) {
    await client.del(key);
    return;
  }
  memoryDel(key);
}
