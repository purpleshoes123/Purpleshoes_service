import { getEnv } from "~/lib/env";
import { getBookingStore } from "~/domains/bookings/bookingStore";

function getRedisClient(): any | null {
  const store = getBookingStore();
  if (typeof (store as any).getRedisClient === "function") {
    return (store as any).getRedisClient();
  }
  return (store as any).client || null;
}

export async function acquireReconcileLock(lockKey: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) {
    return false;
  }

  const env = getEnv();
  const ttlSec = env.INTERNAL_RECONCILE_LOCK_TTL_SEC || 600;
  const result = await client.set(lockKey, "1", "EX", ttlSec, "NX");
  return result === "OK";
}

export async function releaseReconcileLock(lockKey: string): Promise<void> {
  const client = getRedisClient();
  if (!client) {
    return;
  }
  await client.del(lockKey);
}
