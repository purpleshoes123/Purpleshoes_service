import { makeSlotKey } from "./bookingKeys";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "./rebuildStore";
import { withDurableBookingMutation } from "./bookingMutation.server";

async function scanKeys(redisClient: any, pattern: string): Promise<string[]> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const result = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = result[0];
    const batch = result[1] as string[];
    if (batch.length > 0) {
      keys.push(...batch);
    }
  } while (cursor !== "0");
  return keys;
}

async function removeOrderLineIndexes(
  redisClient: any,
  shop: string,
  orderId: string,
  bookingId: string
): Promise<void> {
  const pattern = `booking:idx:orderline:${shop}:${orderId}:*`;
  const keys = await scanKeys(redisClient, pattern);
  for (const key of keys) {
    const value = await redisClient.get(key);
    if (value === bookingId) {
      await redisClient.del(key);
    }
  }
}

async function removeBookingIdFromIndexSets(
  redisClient: any,
  pattern: string,
  bookingId: string
): Promise<void> {
  const keys = await scanKeys(redisClient, pattern);
  for (const key of keys) {
    await redisClient.srem(key, bookingId);
    const remaining = await redisClient.scard(key);
    if (remaining === 0) {
      await redisClient.del(key);
    }
  }
}

async function removeOrderIndexByBookingId(
  redisClient: any,
  shop: string,
  bookingId: string
): Promise<void> {
  const pattern = `booking:idx:order:${shop}:*`;
  const keys = await scanKeys(redisClient, pattern);
  for (const key of keys) {
    await redisClient.srem(key, bookingId);
    const remaining = await redisClient.scard(key);
    if (remaining === 0) {
      await redisClient.del(key);
    }
  }
}

async function removeOrderLineIndexByBookingId(
  redisClient: any,
  shop: string,
  bookingId: string
): Promise<void> {
  const pattern = `booking:idx:orderline:${shop}:*`;
  const keys = await scanKeys(redisClient, pattern);
  for (const key of keys) {
    const value = await redisClient.get(key);
    if (value === bookingId) {
      await redisClient.del(key);
    }
  }
}

async function removeGroupIndexByBookingId(
  redisClient: any,
  shop: string,
  bookingId: string
): Promise<void> {
  const pattern = `booking:idx:group:${shop}:*`;
  const keys = await scanKeys(redisClient, pattern);
  for (const key of keys) {
    const value = await redisClient.get(key);
    if (value === bookingId) {
      await redisClient.del(key);
    }
  }
}

export async function resolveBookingIdsByOrderIndex(
  redisClient: any,
  shop: string,
  orderId: string
): Promise<string[]> {
  const key = RebuildStoreKeys.orderIndex(shop, orderId);
  const bookingIds = await redisClient.smembers(key);
  return bookingIds.filter(Boolean);
}

export async function resolveBookingIdByGroupIndex(
  redisClient: any,
  shop: string,
  groupKey: string,
  orderId?: string
): Promise<string | null> {
  if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
    if (!orderId) throw new Error("Order-scoped booking lookup required");
    const ids = await resolveBookingIdsByOrderIndex(redisClient, shop, orderId);
    if (ids.length > 200) throw new Error("Booking index requires reconciliation");
    const matches = new Set<string>();
    for (const id of ids) {
      const record = await readOrderBooking(redisClient, shop, orderId, id);
      if (record.groupKey === groupKey) matches.add(id);
    }
    // Compatibility with imported records whose order index is incomplete.
    // The old alias is shared across orders; it is never authoritative.
    const alias = await redisClient.get(RebuildStoreKeys.groupIndex(shop, groupKey));
    if (alias && !ids.includes(alias)) {
      const raw = await redisClient.get(RebuildStoreKeys.confirmedBooking(shop, alias));
      let record: ConfirmedBookingRecord;
      try { record = JSON.parse(raw); } catch { throw new Error("Booking index requires reconciliation"); }
      if (!record || record.shop !== shop || record.bookingId !== alias || record.groupKey !== groupKey || !record.orderId) {
        throw new Error("Booking index requires reconciliation");
      }
      if (record.orderId === orderId) matches.add(alias);
    }
    if (matches.size > 1) throw new Error("Booking identity requires reconciliation");
    return [...matches][0] || null;
  }
  const key = RebuildStoreKeys.groupIndex(shop, groupKey);
  const bookingId = await redisClient.get(key);
  return bookingId || null;
}

export async function resolveBookingIdByOrderLineIndex(
  redisClient: any,
  shop: string,
  orderId: string,
  lineItemId: string
): Promise<string | null> {
  const key = RebuildStoreKeys.orderLineIndex(shop, orderId, lineItemId);
  const bookingId = await redisClient.get(key);
  if (bookingId && process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
    await readOrderBooking(redisClient, shop, orderId, bookingId);
  }
  return bookingId || null;
}

async function readOrderBooking(redisClient: any, shop: string, orderId: string, bookingId: string): Promise<ConfirmedBookingRecord> {
  try {
    const record = JSON.parse(await redisClient.get(RebuildStoreKeys.confirmedBooking(shop, bookingId)));
    if (!record || record.shop !== shop || record.orderId !== orderId || record.bookingId !== bookingId ||
        !record.groupKey || record.status !== "confirmed") throw new Error();
    return record;
  } catch { throw new Error("Booking index requires reconciliation"); }
}

export async function resolveBookingIdsByOrderRecord(
  redisClient: any,
  shop: string,
  orderIds: string[]
): Promise<string[]> {
  const pattern = `booking:confirmed:${shop}:*`;
  const keys = await scanKeys(redisClient, pattern);
  const bookingIds: string[] = [];
  const orderIdSet = new Set(orderIds.filter(Boolean).map((id) => String(id)));
  for (const key of keys) {
    const bookingData = await redisClient.get(key);
    if (!bookingData) {
      continue;
    }
    try {
      const booking = JSON.parse(bookingData) as { orderId?: string; bookingId?: string };
      if (booking.bookingId && orderIdSet.has(String(booking.orderId || ""))) {
        bookingIds.push(booking.bookingId);
      }
    } catch {
      // skip invalid payload
    }
  }
  return bookingIds;
}

export async function upsertConfirmedBookingRecord(
  redisClient: any,
  record: ConfirmedBookingRecord,
  lineItemIds: string[],
  beforeProjection?: () => Promise<void>
): Promise<void> {
  const bookingKey = RebuildStoreKeys.confirmedBooking(record.shop, record.bookingId);
  if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && !beforeProjection) {
    throw new Error("Durable booking confirmation requires capacity reconciliation");
  }
  const existing = await redisClient.get(bookingKey);
  const before = existing ? JSON.parse(existing) as ConfirmedBookingRecord : null;
  const after = before ? { ...before, ...record, createdAt: before.createdAt } : record;
  await withDurableBookingMutation({ shop: record.shop, bookingId: record.bookingId, kind: "UPSERT", before, after, lineItemIds }, async () => {
    await beforeProjection?.();
    await projectConfirmedBookingRecord(redisClient, after, lineItemIds);
  });
}

async function projectConfirmedBookingRecord(redisClient: any, record: ConfirmedBookingRecord, lineItemIds: string[]): Promise<void> {
  const bookingKey = RebuildStoreKeys.confirmedBooking(record.shop, record.bookingId);
  await redisClient.set(bookingKey, JSON.stringify(record));

  await redisClient.sadd(
    RebuildStoreKeys.dateIndex(record.shop, record.travelDate),
    record.bookingId
  );
  await redisClient.sadd(
    RebuildStoreKeys.slotIndex(
      record.shop,
      makeSlotKey(record.productId, record.travelDate)
    ),
    record.bookingId
  );
  await redisClient.sadd(
    RebuildStoreKeys.poolIndex(record.shop, `${record.poolKey}|${record.travelDate}`),
    record.bookingId
  );
  await redisClient.sadd(
    RebuildStoreKeys.orderIndex(record.shop, record.orderId),
    record.bookingId
  );
  if (process.env.DEPLOYMENT_MODE?.trim() !== "multi-node") {
    await redisClient.set(RebuildStoreKeys.groupIndex(record.shop, record.groupKey), record.bookingId);
  }

  for (const lineItemId of lineItemIds) {
    await redisClient.set(
      RebuildStoreKeys.orderLineIndex(record.shop, record.orderId, lineItemId),
      record.bookingId
    );
  }

  if (process.env.DEPLOYMENT_MODE?.trim() !== "multi-node") {
    const slotKey = makeSlotKey(record.productId, record.travelDate);
    await redisClient.set(`confirmed:${slotKey}`, "1");
  }
}

/** Update only the record; keep its membership indexes and inherited line IDs.
 * Used for traveler inference and partial refunds, not date/product changes. */
export async function updateConfirmedBookingTravelers(
  redisClient: any,
  before: ConfirmedBookingRecord,
  after: ConfirmedBookingRecord,
): Promise<void> {
  const { travelers: _beforeTravelers, updatedAt: _beforeUpdated, ...beforeIdentity } = before;
  const { travelers: _afterTravelers, updatedAt: _afterUpdated, ...afterIdentity } = after;
  const keys = [...new Set([...Object.keys(beforeIdentity), ...Object.keys(afterIdentity)])].sort();
  if (keys.some(key => JSON.stringify((beforeIdentity as any)[key]) !== JSON.stringify((afterIdentity as any)[key]))) {
    throw new Error("Traveler update must preserve booking identity");
  }
  await withDurableBookingMutation({ shop: before.shop, bookingId: before.bookingId,
    kind: "UPSERT", before, after }, () => redisClient.set(
      RebuildStoreKeys.confirmedBooking(before.shop, before.bookingId), JSON.stringify(after)));
}

export async function removeConfirmedBookingRecord(
  redisClient: any,
  shop: string,
  bookingId: string,
  options?: {
    orderId?: string;
    groupKey?: string;
    cleanupOrphans?: boolean;
    afterProjection?: (record: ConfirmedBookingRecord | null) => Promise<void>;
  }
): Promise<ConfirmedBookingRecord | null> {
  if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && !options?.afterProjection) {
    throw new Error("Durable booking removal requires capacity reconciliation");
  }
  const bookingKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);
  const bookingData = await redisClient.get(bookingKey);

  // A group lookup may collide across orders. Refuse a mismatched record
  // before accepting a durable removal intent or touching either projection.
  if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && bookingData) {
    const record = JSON.parse(bookingData) as ConfirmedBookingRecord;
    if (record.shop !== shop || record.bookingId !== bookingId ||
      (options?.orderId && record.orderId !== options.orderId) ||
      (options?.groupKey && record.groupKey !== options.groupKey)) {
      throw new Error("Booking removal identity mismatch");
    }
  }

  return withDurableBookingMutation({ shop, bookingId, kind: "REMOVE",
    before: bookingData ? JSON.parse(bookingData) as ConfirmedBookingRecord : null, after: null },
    async () => {
      const removed = await removeConfirmedBookingProjection(redisClient, shop, bookingId, bookingData, options);
      // Capacity/legacy effects must finish before the journal becomes APPLIED.
      // A failure remains UNKNOWN; do not retry uncertain decrements here.
      await options?.afterProjection?.(removed);
      return removed;
    });
}

async function removeConfirmedBookingProjection(
  redisClient: any, shop: string, bookingId: string, bookingData: string | null,
  options?: { orderId?: string; groupKey?: string; cleanupOrphans?: boolean },
): Promise<ConfirmedBookingRecord | null> {
  const bookingKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);

  if (!bookingData) {
    if (options?.orderId) {
      await redisClient.srem(
        RebuildStoreKeys.orderIndex(shop, options.orderId),
        bookingId
      );
      await removeOrderLineIndexes(redisClient, shop, options.orderId, bookingId);
    }
    if (options?.groupKey) {
      const groupIndexKey = RebuildStoreKeys.groupIndex(shop, options.groupKey);
      const stored = await redisClient.get(groupIndexKey);
      if (stored === bookingId) {
        await redisClient.del(groupIndexKey);
      }
    } else {
      await removeGroupIndexByBookingId(redisClient, shop, bookingId);
    }
    if (options?.cleanupOrphans) {
      await removeBookingIdFromIndexSets(
        redisClient,
        `booking:date:${shop}:*`,
        bookingId
      );
      await removeBookingIdFromIndexSets(
        redisClient,
        `booking:slot:${shop}:*`,
        bookingId
      );
      await removeBookingIdFromIndexSets(
        redisClient,
        `booking:pool:${shop}:*`,
        bookingId
      );
      await removeOrderIndexByBookingId(redisClient, shop, bookingId);
      await removeOrderLineIndexByBookingId(redisClient, shop, bookingId);
    }
    return null;
  }

  const booking = JSON.parse(bookingData) as ConfirmedBookingRecord;

  await redisClient.del(bookingKey);
  await redisClient.srem(
    RebuildStoreKeys.dateIndex(shop, booking.travelDate),
    bookingId
  );
  await redisClient.srem(
    RebuildStoreKeys.slotIndex(
      shop,
      makeSlotKey(booking.productId, booking.travelDate)
    ),
    bookingId
  );
  await redisClient.srem(
    RebuildStoreKeys.poolIndex(shop, `${booking.poolKey}|${booking.travelDate}`),
    bookingId
  );
  await redisClient.srem(
    RebuildStoreKeys.orderIndex(shop, booking.orderId),
    bookingId
  );

  const groupIndexKey = RebuildStoreKeys.groupIndex(shop, booking.groupKey);
  const storedGroup = await redisClient.get(groupIndexKey);
  if (storedGroup === bookingId) {
    await redisClient.del(groupIndexKey);
  }

  await removeOrderLineIndexes(redisClient, shop, booking.orderId, bookingId);

  // In multi-node mode the watched legacy-capacity transaction owns this
  // flag. Deleting it here can race a just-confirmed reservation.
  if (process.env.DEPLOYMENT_MODE?.trim() !== "multi-node") {
    const slotKey = makeSlotKey(booking.productId, booking.travelDate);
    const slotIndexKey = RebuildStoreKeys.slotIndex(shop, slotKey);
    const remaining = await redisClient.scard(slotIndexKey);
    if (remaining === 0) {
      await redisClient.del(`confirmed:${slotKey}`);
    }
  }

  return booking;
}
