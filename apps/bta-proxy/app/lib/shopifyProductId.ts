const SHOPIFY_PRODUCT_GID_PREFIX = "gid://shopify/Product/";

export function normalizeProductIdForBookings(productId: string): string {
  if (productId.startsWith(SHOPIFY_PRODUCT_GID_PREFIX)) {
    return productId.slice(SHOPIFY_PRODUCT_GID_PREFIX.length);
  }
  return productId;
}
