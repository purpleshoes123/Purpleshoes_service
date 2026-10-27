import { createHash } from "node:crypto";
import db from "~/db.server";
import { resolveBookingIdByGroupIndex } from "./confirmedLedger";

/** Keep historical IDs, including deleted reservations. A delayed paid webhook
 * must reach its original REMOVE tombstone rather than allocate a new identity. */
export async function resolvePaidBookingId(redis: any, shop: string, orderId: string, groupKey: string): Promise<string> {
  if (process.env.DEPLOYMENT_MODE?.trim() !== "multi-node") {
    return createHash("sha256").update(`${shop}|${groupKey}`).digest("hex");
  }
  try {
    if (!redis || !shop || !orderId || !groupKey) throw new Error();
    const rows = await db.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      return tx.$queryRaw<Array<{ booking_id: string }>>`
        SELECT DISTINCT booking_id FROM booking_mutation_journal
        WHERE shop = ${shop}
          AND COALESCE(after_record, before_record)->>'orderId' = ${orderId}
          AND COALESCE(after_record, before_record)->>'groupKey' = ${groupKey}
        LIMIT 2`;
    }, { timeout: 10000, maxWait: 5000 });
    if (rows.length > 1 || rows.some(row => typeof row.booking_id !== "string" || !row.booking_id)) throw new Error();
    const projected = await resolveBookingIdByGroupIndex(redis, shop, groupKey, orderId);
    if (rows[0]) {
      if (projected && projected !== rows[0].booking_id) throw new Error();
      return rows[0].booking_id;
    }
    if (projected) return projected; // Journal acceptance still requires a verified baseline.
    return createHash("sha256").update(JSON.stringify(["booking-order-v1", shop, orderId, groupKey])).digest("hex");
  } catch { throw new Error("Booking identity requires reconciliation"); }
}
