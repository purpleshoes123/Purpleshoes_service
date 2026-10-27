import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { EntitlementType } from "./types";
import { addFixedMonthDaysKstEndOfDay, normalizeToKstEndOfDay } from "./date";
import { listLedgerEvents } from "./ledger";
import type { LedgerEvent } from "./ledger";
import {
  clearCustomerEntitlementMetafield,
  setCustomerEntitlementExpiresAt,
} from "./customerMetafields";

export type RecomputeOutcome =
  | "RECOMPUTED"
  | "CLEARED_AFTER_REFUND"
  | "NO_BASE_NO_CHANGE";

/**
 * Parse base_expires_at from BASE note fallback.
 */
function extractBaseExpiresAtFromNote(note?: string): string | null {
  if (!note) return null;
  const match = note.match(/base_expires_at=([^\s|]+)/);
  return match ? match[1] : null;
}

function extractOrderIdFromNote(note?: string): string | null {
  if (!note) return null;
  const match = note.match(/(?:^|\|)order_id=([^|]+)/);
  return match ? match[1] : null;
}

function isBaseRefundEvent(event: LedgerEvent): boolean {
  return (
    event.eventType === "REFUND" &&
    typeof event.note === "string" &&
    event.note.includes("base_refund=true")
  );
}

function isBaseRefundForSelectedBase(
  event: LedgerEvent,
  baseEvent: LedgerEvent
): boolean {
  if (!isBaseRefundEvent(event)) {
    return false;
  }

  if (!baseEvent.orderId) {
    return true;
  }

  const refundOrderId = event.orderId || extractOrderIdFromNote(event.note);
  return refundOrderId === baseEvent.orderId;
}

/**
 * Recompute entitlement expiration from ledger events.
 * A base refund without a BASE clears stale access; netMonths < 0 clamps to 0.
 */
export async function recomputeEntitlement(params: {
  admin: AdminApiContext;
  customerId: string;
  type: EntitlementType;
  reason?: string;
  additionalEvents?: LedgerEvent[];
}): Promise<{
  customerId: string;
  type: EntitlementType;
  baseExpiresAt: string | null;
  netMonths: number;
  newExpiresAt: string | null;
  outcome: RecomputeOutcome;
  cleared?: boolean;
}> {
  const listedEvents = await listLedgerEvents(params.admin, {
    customerId: params.customerId,
    type: params.type,
  });
  const events = Array.from(
    new Map(
      [...listedEvents, ...(params.additionalEvents || [])].map((event) => [
        event.id,
        event,
      ])
    ).values()
  );

  const toTimestamp = (value?: string | null): number | null => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.getTime();
  };

  const baseEvents = events.filter((event) => event.eventType === "BASE");
  if (baseEvents.length === 0) {
    if (events.some(isBaseRefundEvent)) {
      await clearCustomerEntitlementMetafield(
        params.admin,
        params.customerId,
        params.type
      );
      return {
        customerId: params.customerId,
        type: params.type,
        baseExpiresAt: null,
        netMonths: 0,
        newExpiresAt: null,
        outcome: "CLEARED_AFTER_REFUND",
        cleared: true,
      };
    }

    return {
      customerId: params.customerId,
      type: params.type,
      baseExpiresAt: null,
      netMonths: 0,
      newExpiresAt: null,
      outcome: "NO_BASE_NO_CHANGE",
    };
  }

  const baseEvent = [...baseEvents].sort((a, b) => {
    const aTs = toTimestamp(a.occurredAt);
    const bTs = toTimestamp(b.occurredAt);
    if (aTs !== null && bTs !== null && aTs !== bTs) {
      return bTs - aTs;
    }
    if (aTs !== null && bTs === null) return -1;
    if (aTs === null && bTs !== null) return 1;
    return a.id.localeCompare(b.id);
  })[0];
  const baseRaw =
    baseEvent.baseExpiresAt || extractBaseExpiresAtFromNote(baseEvent.note);
  if (!baseRaw) {
    throw new Error("BASE event missing base_expires_at");
  }

  const baseExpiresAt = normalizeToKstEndOfDay(baseRaw);
  const baseTimestamp = toTimestamp(baseEvent.occurredAt);
  const eventsAfterBase =
    baseTimestamp === null
      ? events
      : events.filter((event) => {
          const ts = toTimestamp(event.occurredAt);
          if (ts === null) return true;
          return ts >= baseTimestamp;
        });

  const baseRefunded = eventsAfterBase.some((event) =>
    isBaseRefundForSelectedBase(event, baseEvent)
  );
  if (baseRefunded) {
    await clearCustomerEntitlementMetafield(
      params.admin,
      params.customerId,
      params.type
    );
    return {
      customerId: params.customerId,
      type: params.type,
      baseExpiresAt,
      netMonths: 0,
      newExpiresAt: null,
      outcome: "CLEARED_AFTER_REFUND",
      cleared: true,
    };
  }

  let sumExtend = 0;
  let sumRefund = 0;
  for (const event of eventsAfterBase) {
    if (event.eventType === "EXTEND") sumExtend += event.months;
    if (event.eventType === "REFUND") {
      if (isBaseRefundEvent(event)) continue;
      sumRefund += event.months;
    }
  }

  let netMonths = sumExtend - sumRefund;
  if (netMonths < 0) {
    netMonths = 0;
  }

  const newExpiresAt = addFixedMonthDaysKstEndOfDay(baseExpiresAt, netMonths);

  await setCustomerEntitlementExpiresAt(
    params.admin,
    params.customerId,
    params.type,
    newExpiresAt
  );

  return {
    customerId: params.customerId,
    type: params.type,
    baseExpiresAt,
    netMonths,
    newExpiresAt,
    outcome: "RECOMPUTED",
  };
}
