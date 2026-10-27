import {
  extractBaseTypeFromVariantId,
  normalizeGuideVariantId,
} from "~/lib/guideExtension/baseLineItems";
import { extractExtensionTypeFromVariantId } from "~/lib/guideExtension/extensionProduct";
import { getCouponRulesConfig } from "~/lib/coupons/config";

export type PostPurchaseKind = "KIT" | "ONLY" | "TOUR" | "EXTENSION";

export type PostPurchaseLine = {
  variantId?: string | null;
  productType?: string | null;
};

export type PostPurchaseSection = {
  kind: PostPurchaseKind;
  onlyTypes?: Array<"PDF" | "VIDEO">;
  extensionTypes?: Array<"PDF" | "VIDEO" | "BUNDLE">;
};

const SECTION_ORDER: PostPurchaseKind[] = ["KIT", "ONLY", "TOUR", "EXTENSION"];

function normalizeProductType(value?: string | null): string {
  return String(value || "").trim().toUpperCase();
}
/**
 * Classifies a completed order for customer-facing confirmation content.
 *
 * This deliberately uses the same environment-backed product identifiers as
 * entitlement and coupon processing. It never grants access; the Viewer and
 * My Page remain the source of truth for access checks.
 */
export function classifyPostPurchaseLines(
  lines: PostPurchaseLine[]
): PostPurchaseSection[] {
  const onlyTypes = new Set<"PDF" | "VIDEO">();
  const extensionTypes = new Set<"PDF" | "VIDEO" | "BUNDLE">();
  let hasKit = false;
  let hasTour = false;

  const couponConfig = getCouponRulesConfig();

  for (const line of lines) {
    const variantId = normalizeGuideVariantId(line.variantId);
    const extensionType = extractExtensionTypeFromVariantId(variantId);
    if (extensionType) {
      extensionTypes.add(extensionType);
      continue;
    }

    const baseType = extractBaseTypeFromVariantId(variantId);
    if (baseType === "BUNDLE") {
      hasKit = true;
      continue;
    }
    if (baseType === "PDF" || baseType === "VIDEO") {
      onlyTypes.add(baseType);
      continue;
    }

    if (couponConfig.tourProductTypes.has(normalizeProductType(line.productType))) {
      hasTour = true;
    }
  }

  const sections: Partial<Record<PostPurchaseKind, PostPurchaseSection>> = {};
  if (hasKit) sections.KIT = { kind: "KIT" };
  if (onlyTypes.size > 0) {
    sections.ONLY = { kind: "ONLY", onlyTypes: Array.from(onlyTypes).sort() };
  }
  if (hasTour) sections.TOUR = { kind: "TOUR" };
  if (extensionTypes.size > 0) {
    sections.EXTENSION = {
      kind: "EXTENSION",
      extensionTypes: Array.from(extensionTypes).sort(),
    };
  }

  return SECTION_ORDER.flatMap((kind) => (sections[kind] ? [sections[kind]] : []));
}
