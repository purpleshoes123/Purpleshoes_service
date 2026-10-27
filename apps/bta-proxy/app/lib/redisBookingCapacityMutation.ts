import type Redis from "ioredis";
import { BookingCapacityConflict } from "./bookingCapacityConflict";

type Identity = { shop: string; orderId: string; groupKey?: string; lineItemId?: string };
type Capacity = Identity & {
  slotKey: string; productId: string; date: string; poolKey: string;
  bookingMode: string; guideUnitsRequired: number;
};

function identityKey(identity: Identity) {
  if (![identity.shop, identity.orderId, identity.groupKey || identity.lineItemId]
    .every(value => typeof value === "string" && value.length > 0) ||
    identity.shop.includes("|") || identity.orderId.includes("|")) throw new Error();
  return `confirmed:${identity.shop}|${identity.orderId}|${identity.groupKey || identity.lineItemId}`;
}

function decode(raw: string, key: string): Capacity {
  const value = JSON.parse(raw) as Capacity;
  if (!value || identityKey(value) !== key || !value.productId || !value.date || !value.poolKey ||
    value.slotKey !== `${value.productId}|${value.date}` || !["private", "shared"].includes(value.bookingMode) ||
    !Number.isSafeInteger(value.guideUnitsRequired) || value.guideUnitsRequired < 1) throw new Error();
  return value;
}

function counter(raw: string | null) {
  if (raw === null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error();
  return Number(raw);
}

async function watchedHoldUnits(client: Redis, index: string, scope: { slot?: string; pool?: string }, deadline: number) {
  // The index was WATCHed before this read. New holds, releases and expired
  // records invalidate EXEC, including holds created after the member list.
  if (await client.scard(index) > 2000) throw new Error();
  const ids = await client.smembers(index);
  if (ids.length > 2000) throw new Error();
  let total = 0;
  for (const id of ids) {
    if (!id || Date.now() >= deadline) throw new Error();
    const key = `hold:${id}`;
    await client.watch(key);
    const raw = await client.get(key);
    if (!raw) continue; // Expired membership; do not modify it during this read.
    const hold = JSON.parse(raw);
    if (!hold || hold.holdId !== id || !Number.isSafeInteger(hold.units) || hold.units < 1 ||
        (scope.slot && hold.slotKey !== scope.slot) || (scope.pool && hold.poolDayKey !== scope.pool) ||
        await client.pttl(key) <= 0) throw new Error();
    total += hold.units;
    if (!Number.isSafeInteger(total)) throw new Error();
  }
  return total;
}

/** Only a known WATCH abort (EXEC === null) may retry. A lost response or a
 * partial EXEC error is uncertain and must remain in the durable journal.
 * Every multi-node legacy-capacity writer must update its slot flag/pool.
 * Use a dedicated connection: WATCH state must never leak between requests.
 * Modern booking-index writers must not separately delete legacy slot flags.
 */
export async function mutateRedisBookingCapacity(
  source: Pick<Redis, "duplicate">,
  identity: Identity,
  move?: { fromDate: string; toDate: string; capacityUnits: number | null },
): Promise<void> {
  let client: Redis | undefined;
  let executionStarted = false;
  try {
    const key = identityKey(identity);
    if (move && (!/^\d{4}-\d{2}-\d{2}$/.test(move.fromDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(move.toDate) || move.fromDate === move.toDate)) throw new Error();
    client = source.duplicate({ lazyConnect: true, retryStrategy: () => null, reconnectOnError: null,
      autoResendUnfulfilledCommands: false, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      connectTimeout: 2000, commandTimeout: 2000 });
    client.on("error", () => { /* Redacted failure below; never log credentials. */ });
    await client.connect();
    const deadline = Date.now() + 10000;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (Date.now() >= deadline) throw new Error();
      await client.watch(key);
      const raw = await client.get(key);
      // No blind decrement or acknowledgement of already-missing state.
      if (!raw) throw new Error();
      const before = decode(raw, key);
      if (move && before.date !== move.fromDate) throw new Error();
      const oldFlag = `confirmed:${before.slotKey}`;
      const oldPool = `pool:${before.poolKey}|${before.date}`;
      const newSlot = move ? `${before.productId}|${move.toDate}` : null;
      const newFlag = newSlot ? `confirmed:${newSlot}` : null;
      const newPool = move ? `pool:${before.poolKey}|${move.toDate}` : null;
      await client.watch(oldFlag, oldPool, ...(newFlag && newPool ? [newFlag, newPool] : []));
      if (await client.get(oldFlag) !== "1") throw new Error();
      const oldCount = counter(await client.get(oldPool));
      if (oldCount < before.guideUnitsRequired) throw new Error();
      if (newFlag && newPool) {
        const flag = await client.get(newFlag);
        if (flag !== null && flag !== "1") throw new Error();
        const newCount = counter(await client.get(newPool));
        if (!Number.isSafeInteger(newCount + before.guideUnitsRequired)) throw new Error();
        if (before.bookingMode === "private") {
          const lock = `lock:slot:${newSlot}`;
          const slotIndex = `hold:slot:${newSlot}`;
          const legacySlot = `slot:${before.productId}:${move!.toDate}::`;
          const legacyIndex = `hold:slot:${legacySlot}`;
          await client.watch(lock, slotIndex, legacyIndex);
          if (flag === "1" || await client.get(lock) !== null ||
              await watchedHoldUnits(client, slotIndex, {slot:newSlot!}, deadline) > 0 ||
              await watchedHoldUnits(client, legacyIndex, {slot:legacySlot}, deadline) > 0) throw new BookingCapacityConflict();
        } else {
          const limit = move!.capacityUnits;
          if (!Number.isSafeInteger(limit) || limit! < 1) throw new Error();
          const pool = `${before.poolKey}|${move!.toDate}`, index = `hold:pool:${pool}`;
          await client.watch(index);
          const held = await watchedHoldUnits(client, index, {pool}, deadline);
          if (newCount + held + before.guideUnitsRequired > limit!) throw new BookingCapacityConflict();
        }
      }

      // Existing storage has no legacy membership set. SCAN outside EXEC
      // avoids blocking Redis with KEYS/Lua; watched flags/pools invalidate
      // this snapshot when another capacity writer changes the same slot.
      let cursor = "0", hasOther = false, pages = 0;
      const seen = new Set<string>();
      do {
        if (++pages > 1000 || Date.now() >= deadline) throw new Error();
        const page = await client.scan(cursor, "MATCH", "confirmed:*|*|*", "COUNT", 200);
        cursor = page[0];
        for (const candidate of page[1]) {
          if (Date.now() >= deadline) throw new Error();
          if (candidate === key || seen.has(candidate)) continue;
          seen.add(candidate);
          if (seen.size > 10000) throw new Error();
          const otherRaw = await client.get(candidate);
          if (otherRaw && decode(otherRaw, candidate).slotKey === before.slotKey) {
            hasOther = true;
            break;
          }
        }
      } while (cursor !== "0" && !hasOther);

      if (Date.now() >= deadline) throw new Error();
      const tx = client.multi();
      if (move && newFlag && newPool && newSlot) {
        tx.set(key, JSON.stringify({ ...before, date: move.toDate, slotKey: newSlot }));
        tx.set(newFlag, "1");
        tx.incrby(newPool, before.guideUnitsRequired);
      } else {
        tx.del(key);
      }
      tx.decrby(oldPool, before.guideUnitsRequired);
      if (hasOther) tx.set(oldFlag, "1");
      else tx.del(oldFlag);
      executionStarted = true;
      const results = await tx.exec();
      if (results === null) { executionStarted = false; continue; } // Explicitly no commands were applied.
      if (results.some(([error]) => error !== null)) throw new Error();
      return;
    }
    throw new Error();
  } catch (error) {
    if (error instanceof BookingCapacityConflict && !executionStarted) throw error;
    throw new Error("Booking capacity change requires reconciliation");
  } finally {
    client?.disconnect();
  }
}
