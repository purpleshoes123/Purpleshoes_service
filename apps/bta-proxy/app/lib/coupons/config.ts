import { normalizeCode, normalizeHandles, normalizeId, normalizeTags } from "./normalize";
import type { CartLine } from "./types";

export type CouponRulesConfig = {
  guideKitVariantIds: Set<string>;
  tourCollectionHandles: Set<string>;
  tourTags: Set<string>;
  tourProductTypes: Set<string>;
  extensionVariantIds: Set<string>;
  extensionTags: Set<string>;
  extensionProductTypes: Set<string>;
  extensionCollectionHandles: Set<string>;
};

let cachedConfig: CouponRulesConfig | null = null;

function parseList(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIdSet(raw?: string | null): Set<string> {
  const set = new Set<string>();
  for (const item of parseList(raw)) {
    const id = normalizeId(item);
    if (id) set.add(id);
  }
  return set;
}

function parseUpperSet(raw?: string | null): Set<string> {
  return normalizeTags(parseList(raw));
}

function parseLowerSet(raw?: string | null): Set<string> {
  return normalizeHandles(parseList(raw));
}

export function getCouponRulesConfig(): CouponRulesConfig {
  if (cachedConfig) return cachedConfig;

  const extensionVariantIds = new Set<string>();
  for (const raw of [
    process.env.GUIDE_EXT_VARIANT_ID_PDF,
    process.env.GUIDE_EXT_VARIANT_ID_VIDEO,
    process.env.GUIDE_EXT_VARIANT_ID_BUNDLE,
  ]) {
    for (const id of parseIdSet(raw)) {
      extensionVariantIds.add(id);
    }
  }

  cachedConfig = {
    guideKitVariantIds: parseIdSet(process.env.GUIDE_BASE_VARIANT_ID_BUNDLE),
    tourCollectionHandles: parseLowerSet(process.env.COUPON_TOUR_COLLECTION_HANDLES || "experience-tours"),
    tourTags: parseUpperSet(process.env.COUPON_TOUR_TAGS || "TOUR"),
    tourProductTypes: parseUpperSet(process.env.COUPON_TOUR_PRODUCT_TYPES || "TOUR"),
    extensionVariantIds,
    extensionTags: parseUpperSet(process.env.COUPON_EXTENSION_TAGS || "EXTENSION"),
    extensionProductTypes: parseUpperSet(process.env.COUPON_EXTENSION_PRODUCT_TYPES || "EXTENSION"),
    extensionCollectionHandles: parseLowerSet(process.env.COUPON_EXTENSION_COLLECTION_HANDLES || "extensions"),
  };

  return cachedConfig;
}

export function resetCouponRulesConfigCache(): void {
  cachedConfig = null;
}

export type LineItemLike = {
  productId?: string | number | null;
  variantId?: string | number | null;
  sku?: string | null;
  tags?: string[] | null;
  productType?: string | null;
  collections?: string[] | null;
};

export function isGuideKitBundleLineItem(
  lineItem: LineItemLike,
  config = getCouponRulesConfig()
): boolean {
  const variantId = normalizeId(lineItem.variantId ?? null);
  if (variantId && config.guideKitVariantIds.has(variantId)) {
    return true;
  }
  return false;
}

export function isExtensionLineItem(
  lineItem: CartLine,
  config = getCouponRulesConfig()
): boolean {
  const variantId = normalizeId(lineItem.variantId ?? null);
  if (variantId && config.extensionVariantIds.has(variantId)) {
    return true;
  }

  const tags = normalizeTags(lineItem.tags ?? null);
  for (const tag of tags) {
    if (config.extensionTags.has(tag)) return true;
  }

  const productType = normalizeCode(lineItem.productType ?? null);
  if (productType && config.extensionProductTypes.has(productType)) {
    return true;
  }

  const collections = normalizeHandles(lineItem.collections ?? null);
  for (const handle of collections) {
    if (config.extensionCollectionHandles.has(handle)) return true;
  }

  return false;
}

export function containsExtension(
  lines: CartLine[],
  config = getCouponRulesConfig()
): boolean {
  return lines.some((line) => isExtensionLineItem(line, config));
}
