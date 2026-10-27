import type { EntitlementType } from "./types";
import {
  extractExtensionTypeFromVariantId,
  extractMonthsFromQuantity,
} from "./extensionProduct";

export type ExtensionLineItemPayload = {
  sku?: string | null;
  quantity?: number | null;
  variant_id?: string | number | null;
};

export type ExtensionMonthsMap = Record<EntitlementType, number>;

/**
 * Resolve entitlement type from variant id.
 */
function resolveEntitlementType(
  lineItem: ExtensionLineItemPayload
): EntitlementType | null {
  return extractExtensionTypeFromVariantId(lineItem.variant_id ?? null);
}

/**
 * Aggregate extension months from line items (orders or refunds).
 */
export function extractExtensionMonthsFromLineItems(
  lineItems: ExtensionLineItemPayload[]
): ExtensionMonthsMap {
  const totals: ExtensionMonthsMap = { PDF: 0, VIDEO: 0, BUNDLE: 0 };

  for (const lineItem of lineItems) {
    const type = resolveEntitlementType(lineItem);
    if (!type) continue;

    const months = extractMonthsFromQuantity(lineItem.quantity ?? null);
    if (!months) continue;

    totals[type] += months;
  }

  return totals;
}
