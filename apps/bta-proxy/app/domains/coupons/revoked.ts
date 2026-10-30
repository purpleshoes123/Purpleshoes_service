import { getCouponRedisClient } from "./redisClient";
import { revokedCustomerKey, revokedCodeKey } from "./keys";
import { memorySAdd, memorySIsMember, memorySMembers, memorySRem } from "./memoryStore";
import { normalizeCode } from "./normalize";
import {
  usesDurableCouponState,
  markDurableRevoked,
  unmarkDurableRevoked,
  isDurableRevoked,
  listDurableRevoked,
} from "./durableState.server.ts";

export async function markRevoked(customerId: string, code: string): Promise<void> {
  const normalized = normalizeCode(code);
  if (!normalized) {
    return;
  }
  if (usesDurableCouponState()) {
    return markDurableRevoked(revokedCustomerKey(customerId), normalized);
  }
  const client = getCouponRedisClient();
  if (client) {
    await client.sadd(revokedCustomerKey(customerId), normalized);
    await client.sadd(revokedCodeKey(), normalized);
    return;
  }
  memorySAdd(revokedCustomerKey(customerId), normalized);
  memorySAdd(revokedCodeKey(), normalized);
}

export async function isRevoked(customerId: string, code: string): Promise<boolean> {
  const normalized = normalizeCode(code);
  if (!normalized) {
    return false;
  }
  if (usesDurableCouponState()) {
    return isDurableRevoked(revokedCustomerKey(customerId), normalized);
  }
  const client = getCouponRedisClient();
  if (client) {
    const [customerHit, globalHit] = await Promise.all([
      client.sismember(revokedCustomerKey(customerId), normalized),
      client.sismember(revokedCodeKey(), normalized),
    ]);
    return Boolean(customerHit || globalHit);
  }

  return (
    memorySIsMember(revokedCustomerKey(customerId), normalized) ||
    memorySIsMember(revokedCodeKey(), normalized)
  );
}

export async function listRevoked(customerId: string): Promise<Set<string>> {
  if (usesDurableCouponState()) {
    return listDurableRevoked(revokedCustomerKey(customerId));
  }
  const client = getCouponRedisClient();
  if (client) {
    const values = await client.smembers(revokedCustomerKey(customerId));
    return new Set(values);
  }
  return new Set(memorySMembers(revokedCustomerKey(customerId)));
}

export async function unmarkRevoked(customerId: string, code: string): Promise<void> {
  const normalized = normalizeCode(code);
  if (!normalized) {
    return;
  }
  if (usesDurableCouponState()) {
    return unmarkDurableRevoked(revokedCustomerKey(customerId), normalized);
  }
  const client = getCouponRedisClient();
  if (client) {
    await client.srem(revokedCustomerKey(customerId), normalized);
    await client.srem(revokedCodeKey(), normalized);
    return;
  }
  memorySRem(revokedCustomerKey(customerId), normalized);
  memorySRem(revokedCodeKey(), normalized);
}

export async function filterRevoked(customerId: string, codes: Set<string>): Promise<Set<string>> {
  const revoked = await listRevoked(customerId);
  if (revoked.size === 0) {
    return new Set(codes);
  }
  const filtered = new Set<string>();
  for (const code of codes) {
    if (!revoked.has(normalizeCode(code) || code)) {
      filtered.add(code);
    }
  }
  return filtered;
}
