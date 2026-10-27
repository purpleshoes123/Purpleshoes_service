import { randomUUID } from "crypto";

export type CheckoutMode = "legacy_checkout_url" | "theme_cart" | "private_draft";

export type ThemeCartCheckoutKind = "TOUR" | "GUIDE_BASE" | "GUIDE_EXTENSION";

export type ThemeCartItem = {
  id: string;
  quantity: number;
  properties?: Record<string, string>;
};

export type ThemeCartCheckoutIntent<
  TDecision extends string,
  TAppliedCodes extends object,
> = {
  checkoutMode: "theme_cart";
  prepareId: string;
  clearCart: true;
  items: ThemeCartItem[];
  discountCodes: string[];
  expectedDiscountCodes: string[];
  cartAttributes: Record<string, string>;
  redirectPath: "/checkout";
  decision: TDecision;
  appliedCodes: TAppliedCodes;
  warnings: string[];
};

export type StorefrontCartLineLike = {
  merchandiseId: string;
  quantity: number;
  attributes?: Array<{ key: string; value: string }>;
};

export function createThemeCartPrepareId(kind: ThemeCartCheckoutKind): string {
  return `bta_${kind.toLowerCase()}_${randomUUID()}`;
}

export function normalizeAjaxVariantId(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("Variant id is required");
  }
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    const id = parts[parts.length - 1];
    if (!id) {
      throw new Error(`Invalid Shopify variant GID: ${raw}`);
    }
    return id;
  }
  return raw;
}

export function normalizePropertyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  return normalized.length > 0 ? normalized : null;
}

export function buildThemeCartProperties(
  attributes: Array<{ key: string; value: unknown }> | undefined,
  meta: {
    prepareId: string;
    checkoutKind: ThemeCartCheckoutKind;
  },
): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const attr of attributes || []) {
    const key = String(attr.key || "").trim();
    if (!key) continue;
    const value = normalizePropertyValue(attr.value);
    if (value === null) continue;
    properties[key] = value;
  }
  properties._bta_prepare_id = meta.prepareId;
  properties._bta_checkout_kind = meta.checkoutKind;
  return properties;
}

export function buildThemeCartItemsFromStorefrontLines(params: {
  lines: StorefrontCartLineLike[];
  prepareId: string;
  checkoutKind: ThemeCartCheckoutKind;
}): ThemeCartItem[] {
  return params.lines.map((line) => ({
    id: normalizeAjaxVariantId(line.merchandiseId),
    quantity: line.quantity,
    properties: buildThemeCartProperties(line.attributes, {
      prepareId: params.prepareId,
      checkoutKind: params.checkoutKind,
    }),
  }));
}

export function buildThemeCartAttributes(params: {
  prepareId: string;
  checkoutKind: ThemeCartCheckoutKind;
  decision?: string;
}): Record<string, string> {
  return {
    bta_prepare_id: params.prepareId,
    bta_checkout_kind: params.checkoutKind,
    ...(params.decision ? { bta_decision: params.decision } : {}),
  };
}
