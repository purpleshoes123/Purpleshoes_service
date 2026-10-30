import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  mapSnapshot,
  PRODUCT_VARIANTS_SNAPSHOT_QUERY,
  type ProductVariantsSnapshot,
} from "./productSnapshotQuery";

export async function fetchProductVariantsSnapshot(
  adminClient: AdminApiContext,
  productId: string,
): Promise<ProductVariantsSnapshot> {
  const response = await adminClient.graphql(PRODUCT_VARIANTS_SNAPSHOT_QUERY, {
    variables: { productId },
  });

  if (!response.ok) {
    throw new Error("Shopify Admin GraphQL product snapshot 조회 실패");
  }

  const json = await response.json();
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error: { message?: string }) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      errorMessage
        ? `Shopify Admin GraphQL product snapshot 조회 실패: ${errorMessage}`
        : "Shopify Admin GraphQL product snapshot 조회 실패",
    );
  }

  return mapSnapshot(json);
}
