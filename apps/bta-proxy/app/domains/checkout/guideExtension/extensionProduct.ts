import type { EntitlementType } from "./types";

export type ExtensionLineItemLike = {
  sku?: string | null;
  quantity?: number | null;
  variant_id?: string | number | null;
};

function normalizeVariantId(value?: string | number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    return parts[parts.length - 1] || null;
  }
  return raw;
}

function getExtensionVariantIdMap(): Record<EntitlementType, string | null> {
  return {
    PDF: normalizeVariantId(process.env.GUIDE_EXT_VARIANT_ID_PDF),
    VIDEO: normalizeVariantId(process.env.GUIDE_EXT_VARIANT_ID_VIDEO),
    BUNDLE: normalizeVariantId(process.env.GUIDE_EXT_VARIANT_ID_BUNDLE),
  };
}

/**
 * Extract entitlement type by variant id.
 */
export function extractExtensionTypeFromVariantId(
  variantId?: string | number | null,
): EntitlementType | null {
  const normalized = normalizeVariantId(variantId ?? null);
  if (!normalized) {
    return null;
  }

  const map = getExtensionVariantIdMap();
  for (const [type, envVariantId] of Object.entries(map)) {
    if (envVariantId && envVariantId === normalized) {
      return type as EntitlementType;
    }
  }

  return null;
}

/**
 * Determine whether a line item is a guide extension.
 * Phase 1 uses SKU rule only (EXT_*_1M).
 */
export function isExtensionLineItem(lineItem: ExtensionLineItemLike): boolean {
  return extractExtensionTypeFromVariantId(lineItem.variant_id ?? null) !== null;
}

/**
 * Extract months from quantity.
 * Only integer >= 1 is valid; otherwise returns null.
 */
export function extractMonthsFromQuantity(quantity?: number | null): number | null {
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return null;
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return null;
  }
  return quantity;
}
