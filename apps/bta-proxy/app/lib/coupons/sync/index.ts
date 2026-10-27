import type { CartDiscountAdapter } from "./adapter";
import { MockCartDiscountAdapter } from "./mockAdapter";
import { StorefrontCartDiscountAdapter } from "./storefrontAdapter";

export type CartAdapterType = "mock" | "storefront";

export function getCartDiscountAdapter(): CartDiscountAdapter {
  const preferred = (process.env.COUPON_CART_ADAPTER || "").toLowerCase();
  if (preferred === "storefront") {
    return new StorefrontCartDiscountAdapter();
  }
  if (preferred === "mock") {
    return new MockCartDiscountAdapter();
  }

  if (process.env.SHOPIFY_STOREFRONT_TOKEN) {
    return new StorefrontCartDiscountAdapter();
  }

  return new MockCartDiscountAdapter();
}

export * from "./adapter";
export * from "./diff";
export * from "./mockCartStore";
export * from "./mockAdapter";
export * from "./storefrontAdapter";
