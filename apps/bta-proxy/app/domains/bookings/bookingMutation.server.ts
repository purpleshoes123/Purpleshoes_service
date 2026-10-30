import { randomUUID } from "node:crypto";
import db from "~/db.server.ts";
import type { ConfirmedBookingRecord } from "./rebuildStore";
import { BookingCapacityConflict } from "./bookingCapacityConflict";

export type BookingMutation = {
  shop: string;
  bookingId: string;
  kind: "UPSERT" | "RESCHEDULE" | "REMOVE";
  before: ConfirmedBookingRecord | null;
  after: ConfirmedBookingRecord | null;
  lineItemIds?: string[];
};

function canonical(value: unknown): string {
  function sort(item: any): any {
    if (Array.isArray(item)) {
      return item.map(sort);
    }
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  }
  return JSON.stringify(sort(value));
}

function validate(change: BookingMutation) {
  if (
    !change.shop ||
    !change.bookingId ||
    !["UPSERT", "RESCHEDULE", "REMOVE"].includes(change.kind)
  ) {
    throw new Error();
  }
  for (const record of [change.before, change.after]) {
    if (
      record &&
      (record.shop !== change.shop ||
        record.bookingId !== change.bookingId ||
        !record.orderId ||
        !record.groupKey ||
        !record.travelDate ||
        record.status !== "confirmed")
    ) {
      throw new Error();
    }
  }
  if (
    (change.kind === "REMOVE") !== (change.after === null) ||
    (change.kind === "RESCHEDULE" && !change.before)
  ) {
    throw new Error();
  }
  if (change.lineItemIds?.some((id) => typeof id !== "string" || !id)) {
    throw new Error();
  }
  if (change.before && change.after) {
    for (const field of [
      "orderId",
      "groupKey",
      "productId",
      "poolKey",
      "bookingMode",
      "guideUnitsRequired",
    ] as const) {
      if (change.before[field] !== change.after[field]) {
        throw new Error();
      }
    }
  }
  // Paid-webhook retries must not undo an administrator's date change.
  if (
    change.kind === "UPSERT" &&
    change.before &&
    change.before.travelDate !== change.after?.travelDate
  ) {
    throw new Error();
  }
}

/** The intent commits BEFORE Redis writes. An unknown result is never replayed
 * blindly: Redis MULTI does not roll back partial writes or increments. */
export async function withDurableBookingMutation<T>(
  change: BookingMutation,
  apply: () => Promise<T>,
): Promise<T> {
  if (process.env.DEPLOYMENT_MODE?.trim() !== "multi-node") {
    return apply();
  }
  const id = randomUUID();
  try {
    validate(change);
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtext(${change.shop}), hashtext(${change.bookingId}))`;
        const rows = await tx.$queryRaw<
          Array<{
            state: string;
            kind: string;
            before_record: unknown;
            after_record: unknown;
            line_item_ids: unknown;
          }>
        >`
        SELECT state, kind, before_record, after_record, line_item_ids FROM booking_mutation_journal
        WHERE shop = ${change.shop} AND booking_id = ${change.bookingId}
        ORDER BY sequence DESC LIMIT 1`;
        const last = rows[0];
        if (
          last &&
          (!["APPLIED", "ABORTED"].includes(last.state) ||
            (last.state === "ABORTED" &&
              !(
                (last.kind === "RESCHEDULE" && last.before_record) ||
                (last.kind === "UPSERT" && last.before_record === null && last.after_record)
              )) ||
            canonical(last.state === "ABORTED" ? last.before_record : last.after_record) !==
              canonical(change.before))
        ) {
          throw new Error();
        }
        if (!last && change.before !== null) {
          throw new Error();
        } // Existing data requires a verified baseline import.
        if (last?.kind === "REMOVE" && change.kind === "UPSERT") {
          throw new Error();
        }
        if (last?.state === "ABORTED" && last.kind === "UPSERT") {
          // A retry may not reinterpret an unfulfilled paid order as another booking.
          for (const field of [
            "orderId",
            "groupKey",
            "productId",
            "poolKey",
            "bookingMode",
            "guideUnitsRequired",
            "travelDate",
          ] as const) {
            if ((last.after_record as ConfirmedBookingRecord)[field] !== change.after?.[field]) {
              throw new Error();
            }
          }
        }
        const lineItems = change.lineItemIds ?? last?.line_item_ids ?? [];
        await tx.$executeRaw`
        INSERT INTO booking_mutation_journal
          (id, shop, booking_id, kind, state, before_record, after_record, line_item_ids)
        VALUES (${id}, ${change.shop}, ${change.bookingId}, ${change.kind}, 'PENDING',
          ${change.before === null ? null : JSON.stringify(change.before)}::jsonb,
          ${change.after === null ? null : JSON.stringify(change.after)}::jsonb,
          ${JSON.stringify(lineItems)}::jsonb)`;
      },
      { timeout: 10000, maxWait: 5000 },
    );
  } catch {
    throw new Error("Booking change could not be durably accepted");
  }

  try {
    const result = await apply();
    const updated = await db.$executeRaw`
      UPDATE booking_mutation_journal SET state = 'APPLIED', completed_at = CURRENT_TIMESTAMP
      WHERE id = ${id} AND state = 'PENDING'`;
    if (updated !== 1) {
      throw new Error();
    }
    return result;
  } catch (error) {
    // These callbacks perform capacity first. This typed rejection is
    // proof that no Redis effects started, not an inference from an error text.
    if (
      error instanceof BookingCapacityConflict &&
      (change.kind === "RESCHEDULE" || (change.kind === "UPSERT" && change.before === null))
    ) {
      let aborted = false;
      try {
        const updated = await db.$executeRaw`
          UPDATE booking_mutation_journal SET state = 'ABORTED', completed_at = CURRENT_TIMESTAMP
          WHERE id = ${id} AND state = 'PENDING'
            AND (kind = 'RESCHEDULE' OR (kind = 'UPSERT' AND before_record IS NULL))`;
        aborted = updated === 1;
      } catch {
        /* A lost database reply still requires reconciliation. */
      }
      if (aborted) {
        throw error;
      }
    }
    // If this update also fails, PENDING already persists and still blocks a
    // conflicting mutation. Never delete evidence or mark it safe to retry.
    try {
      await db.$executeRaw`UPDATE booking_mutation_journal SET state = 'UNKNOWN'
        WHERE id = ${id} AND state = 'PENDING'`;
    } catch {
      /* Intent was committed before the effect. */
    }
    throw new Error("Booking change requires reconciliation before retry");
  }
}

export async function assertBookingJournalReady(): Promise<void> {
  try {
    const rows = await db.$queryRaw<Array<{ ready: boolean }>>`
      SELECT (EXISTS (SELECT 1 FROM fleet_state_migrations WHERE id = 'booking-v1')
        AND NOT EXISTS (SELECT 1 FROM booking_mutation_journal WHERE state = 'UNKNOWN'
          OR (state = 'PENDING' AND created_at < CURRENT_TIMESTAMP - INTERVAL '2 minutes'))) AS ready`;
    if (rows[0]?.ready !== true) {
      throw new Error();
    }
  } catch {
    throw new Error("Booking journal requires verification or reconciliation");
  }
}
