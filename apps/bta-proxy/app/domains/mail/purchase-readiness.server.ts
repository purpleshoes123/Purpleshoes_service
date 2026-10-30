import type { PurchaseEmailOutbox } from "@prisma/client";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { getCustomerEntitlements } from "~/domains/checkout/guideExtension/customerMetafields";
import type { EntitlementType } from "~/domains/checkout/guideExtension/types";
import db from "~/db.server.ts";
import { getPurchaseServiceEmailCutover } from "./purchase-service-policy.server.ts";
import { getRedisBookingClient } from "~/domains/bookings/bookingStore";
import { resolveBookingIdsByOrderIndex } from "~/domains/bookings/confirmedLedger";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "~/domains/bookings/rebuildStore";

export const PURCHASE_ORDER_QUERY = `#graphql
  query PurchaseEmailOrder($id: ID!) {
    order(id: $id) {
      displayFinancialStatus
      cancelledAt
      email
      customer { id }
    }
  }
`;
export type PurchaseReadiness =
  | { status: "READY"; email: string }
  | { status: "WAIT" | "CANCELED" };

export async function checkPurchaseReadiness(row: PurchaseEmailOutbox): Promise<PurchaseReadiness> {
  const service = row.kind === "TOUR" || row.kind === "GUIDE_EXTENSION";
  if (service && !getPurchaseServiceEmailCutover()) {
    return { status: "WAIT" };
  }
  const admin = await getAdminApiClient(row.shopDomain);
  if (!admin) {
    throw new Error("Purchase email Admin API unavailable");
  }
  const response = await admin.graphql(PURCHASE_ORDER_QUERY, {
    variables: { id: `gid://shopify/Order/${row.orderId}` },
  });
  if (!response.ok) {
    throw new Error("Purchase email order lookup failed");
  }
  const result = (await response.json()) as {
    errors?: unknown[];
    data?: {
      order?: {
        displayFinancialStatus?: string;
        cancelledAt?: string | null;
        email?: string | null;
        customer?: { id: string } | null;
      } | null;
    };
  };
  if (result.errors?.length) {
    throw new Error("Purchase email order lookup failed");
  }
  const order = result.data?.order;
  if (!order) {
    return { status: "WAIT" };
  }
  if (
    order.cancelledAt ||
    ["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"].includes(order.displayFinancialStatus || "")
  ) {
    return { status: "CANCELED" };
  }
  if (order.displayFinancialStatus !== "PAID" || !order.customer?.id) {
    return { status: "WAIT" };
  }
  const email = String(order.email || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\r\n]/.test(email)) {
    return { status: "WAIT" };
  }
  if (row.kind === "TOUR") {
    const { bookingGroupKeys } = JSON.parse(row.entitlementTypes);
    if (
      !Array.isArray(bookingGroupKeys) ||
      !bookingGroupKeys.length ||
      bookingGroupKeys.some((key) => typeof key !== "string" || !key)
    ) {
      throw new Error("Invalid booking groups");
    }
    if (process.env.BOOKING_STORE_TYPE === "redis") {
      const redis = getRedisBookingClient();
      if (!redis) {
        return { status: "WAIT" };
      } // Never trust the in-memory fallback in a separate worker.
      const ids = await resolveBookingIdsByOrderIndex(redis, row.shopDomain, row.orderId);
      const confirmed = new Set<string>();
      for (const id of ids) {
        const raw = await redis.get(RebuildStoreKeys.confirmedBooking(row.shopDomain, id));
        if (!raw) {
          continue;
        }
        const booking = JSON.parse(raw) as ConfirmedBookingRecord;
        if (
          booking.shop === row.shopDomain &&
          String(booking.orderId) === row.orderId &&
          booking.status === "confirmed"
        ) {
          confirmed.add(booking.groupKey);
        }
      }
      return bookingGroupKeys.every((key) => confirmed.has(key))
        ? { status: "READY", email }
        : { status: "WAIT" };
    }
    const bookings = await db.confirmedBooking.findMany({
      where: { shop: row.shopDomain, orderId: row.orderId, groupKey: { in: bookingGroupKeys } },
      select: { groupKey: true },
    });
    return bookingGroupKeys.every((key) => bookings.some((booking) => booking.groupKey === key))
      ? { status: "READY", email }
      : { status: "WAIT" };
  }
  // Do not announce access before the paid-order entitlement handler has finished.
  const entitlements = await getCustomerEntitlements(admin, order.customer.id);
  const types: EntitlementType[] = JSON.parse(row.entitlementTypes);
  if (!types.length || types.some((type) => !["PDF", "VIDEO", "BUNDLE"].includes(type))) {
    throw new Error("Invalid entitlement types");
  }
  if (row.kind === "GUIDE_EXTENSION") {
    // An old, still-active base entitlement is NOT proof this extension succeeded.
    const logs = await db.guideEntitlementLog.findMany({
      where: {
        shop: row.shopDomain,
        orderId: row.orderId,
        customerId: order.customer.id,
        topic: "orders/paid",
        eventType: "EXTEND",
        status: "SUCCESS",
        entitlementType: { in: types },
      },
      select: { entitlementType: true, newExpiresAt: true },
    });
    if (
      !types.every((type) =>
        logs.some(
          (log) =>
            log.entitlementType === type &&
            log.newExpiresAt &&
            log.newExpiresAt.getTime() > Date.now(),
        ),
      )
    ) {
      return { status: "WAIT" };
    }
  }
  const active = (value?: string | null) => Boolean(value && Date.parse(value) > Date.now());
  if (
    !types.every(
      (type) => active(entitlements[type]) || (type !== "BUNDLE" && active(entitlements.BUNDLE)),
    )
  ) {
    return { status: "WAIT" };
  }
  return { status: "READY", email };
}
