import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { fetchProductByExternalKey } from "~/lib/adminProductRead/fetchProductByExternalKey";

export async function fetchProductIdByExternalKey(
  adminClient: AdminApiContext,
  externalKey: string
): Promise<string | null> {
  const product = await fetchProductByExternalKey(adminClient, externalKey);
  if (!product?.id) {
    return null;
  }
  return product.id;
}
