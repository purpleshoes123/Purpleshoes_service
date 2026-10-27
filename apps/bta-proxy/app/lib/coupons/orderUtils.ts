import { isGuideKitBundleLineItem } from "./config";
import type { LineItemLike } from "./config";
import { isExtra10Code, isGuide50Code } from "./policy/codes";

export type OrderLineItem = {
  product_id?: number | string | null;
  variant_id?: number | string | null;
  sku?: string | null;
  properties?: Array<{ name: string; value: string }>;
};

export function orderContainsGuideKitBundle(
  lineItems: OrderLineItem[]
): boolean {
  return lineItems.some((item) => {
    const candidate: LineItemLike = {
      productId: item.product_id ?? null,
      variantId: item.variant_id ?? null,
      sku: item.sku ?? null,
    };
    return isGuideKitBundleLineItem(candidate);
  });
}

export type OrderDiscountLike = {
  discount_codes?: Array<{ code?: string | null } | string> | null;
  discount_applications?: Array<{ code?: string | null } | string> | null;
};

export type RefundLineItemLike = {
  quantity?: number | null;
  line_item?: (OrderLineItem & { quantity?: number | null }) | null;
} & OrderLineItem;

function collectDiscountCodes(values: Array<{ code?: string | null } | string> | null | undefined) {
  const codes: string[] = [];
  for (const value of values || []) {
    const code = typeof value === "string" ? value : value?.code;
    if (code && code.trim()) {
      codes.push(code.trim());
    }
  }
  return codes;
}

export function extractGuide50DiscountCodes(order: OrderDiscountLike): string[] {
  const codes = [
    ...collectDiscountCodes(order.discount_codes),
    ...collectDiscountCodes(order.discount_applications),
  ];
  return Array.from(new Set(codes.filter(isGuide50Code)));
}

export function extractExtra10DiscountCodes(order: OrderDiscountLike): string[] {
  const codes = [
    ...collectDiscountCodes(order.discount_codes),
    ...collectDiscountCodes(order.discount_applications),
  ];
  return Array.from(new Set(codes.filter(isExtra10Code)));
}

export function refundContainsFullyRefundedGuideKitBundle(
  refundLineItems: RefundLineItemLike[]
): boolean {
  return refundLineItems.some((item) => {
    const lineItem = item.line_item || item;
    const refundQuantity = typeof item.quantity === "number" ? item.quantity : 0;
    const originalQuantity =
      typeof item.line_item?.quantity === "number"
        ? item.line_item.quantity
        : 0;
    return (
      refundQuantity > 0 &&
      refundQuantity >= originalQuantity &&
      orderContainsGuideKitBundle([lineItem])
    );
  });
}

export function refundLineItemsAreFullyRefunded(
  refundLineItems: RefundLineItemLike[]
): boolean {
  if (refundLineItems.length === 0) return false;
  return refundLineItems.every((item) => {
    const refundQuantity = typeof item.quantity === "number" ? item.quantity : 0;
    const originalQuantity =
      typeof item.line_item?.quantity === "number"
        ? item.line_item.quantity
        : 0;
    return refundQuantity > 0 && originalQuantity > 0 && refundQuantity >= originalQuantity;
  });
}
