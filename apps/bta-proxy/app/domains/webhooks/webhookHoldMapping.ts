/**
 * Hold Mapping Extractor
 * Phase 2: payload에서 holdId/attemptId/holdKey 추출
 */

import { extractBookingInfoFromLineItem } from "~/domains/webhooks/webhookUtils";

export interface HoldMappingResult {
  holdIds: string[];
  attemptIds: string[];
  holdKeys: string[];
}

const HOLD_ID_KEYS = ["hold_id", "holdId"];
const HOLD_KEY_KEYS = ["hold_key", "holdKey"];
const ATTEMPT_ID_KEYS = [
  "attemptId",
  "attempt_id",
  "idempotencyKey",
  "idempotency_key",
  "clientRequestId",
];

function normalizeValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function extractValuesFromProperties(
  properties: Array<{ name?: string; key?: string; value?: string }> | undefined,
  keys: string[],
): string[] {
  if (!Array.isArray(properties)) {
    return [];
  }
  const results: string[] = [];
  for (const prop of properties) {
    const name = normalizeValue(prop?.name ?? prop?.key);
    if (!name) {
      continue;
    }
    if (keys.includes(name)) {
      const value = normalizeValue(prop?.value);
      if (value) {
        results.push(value);
      }
    }
  }
  return results;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function extractLineItemsFromPayload(payload: Record<string, any>): any[] {
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const refundLineItems = Array.isArray(payload?.refund_line_items)
    ? payload.refund_line_items
    : [];

  const normalizedRefundLineItems = refundLineItems.map((item: any) => {
    const lineItem = item?.line_item ?? {};
    return {
      ...lineItem,
      id: item?.line_item_id ?? item?.id ?? lineItem?.id,
      product_id: item?.product_id ?? lineItem?.product_id,
      variant_id: item?.variant_id ?? lineItem?.variant_id,
      properties: item?.properties ?? lineItem?.properties,
    };
  });

  return [...lineItems, ...normalizedRefundLineItems];
}

/**
 * payload에서 holdId/attemptId/holdKey 추출
 * 우선순위:
 * 1) line_items[].properties
 * 2) note_attributes
 */
export async function extractHoldMapping(
  payload: Record<string, any>,
  shop?: string | null,
): Promise<HoldMappingResult> {
  const lineItems = extractLineItemsFromPayload(payload);

  // 여행상품 line_item만 필터링 (가능하면)
  const travelLineItems: any[] = [];
  for (const lineItem of lineItems) {
    try {
      const bookingInfo = await extractBookingInfoFromLineItem(lineItem, shop || undefined);
      if (bookingInfo) {
        travelLineItems.push(lineItem);
      }
    } catch {
      // 실패 시 해당 line item은 제외
    }
  }

  const targetLineItems = travelLineItems.length > 0 ? travelLineItems : lineItems;

  const holdIds: string[] = [];
  const attemptIds: string[] = [];
  const holdKeys: string[] = [];

  for (const lineItem of targetLineItems) {
    const properties = lineItem?.properties;
    holdIds.push(...extractValuesFromProperties(properties, HOLD_ID_KEYS));
    attemptIds.push(...extractValuesFromProperties(properties, ATTEMPT_ID_KEYS));
    holdKeys.push(...extractValuesFromProperties(properties, HOLD_KEY_KEYS));
  }

  // note_attributes fallback
  const noteAttributes = Array.isArray(payload?.note_attributes) ? payload.note_attributes : [];

  if (noteAttributes.length > 0) {
    holdIds.push(...extractValuesFromProperties(noteAttributes, HOLD_ID_KEYS));
    attemptIds.push(...extractValuesFromProperties(noteAttributes, ATTEMPT_ID_KEYS));
    holdKeys.push(...extractValuesFromProperties(noteAttributes, HOLD_KEY_KEYS));
  }

  return {
    holdIds: unique(holdIds),
    attemptIds: unique(attemptIds),
    holdKeys: unique(holdKeys),
  };
}
