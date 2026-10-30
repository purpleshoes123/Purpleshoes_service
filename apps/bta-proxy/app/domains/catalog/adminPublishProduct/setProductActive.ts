import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  formatUserErrors,
  mapSetActive,
  SET_PRODUCT_ACTIVE_MUTATION,
} from "~/domains/catalog/adminPublishProduct/setActiveQuery";

export async function setProductActive(
  adminClient: AdminApiContext,
  productId: string,
): Promise<{ productId: string; status: string }> {
  const response = await adminClient.graphql(SET_PRODUCT_ACTIVE_MUTATION, {
    variables: { id: productId },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin GraphQL product status ACTIVE 전환 실패: productId=${productId}`,
    );
  }

  const json = await response.json();
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error: { message?: string }) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Shopify Admin GraphQL product status ACTIVE 전환 실패: ${errorMessage}; productId=${productId}`,
    );
  }

  const userErrors = formatUserErrors(json?.data?.productUpdate?.userErrors ?? []);
  if (userErrors.length > 0) {
    throw new Error(
      `product status ACTIVE 전환 실패: ${userErrors.join(", ")}; productId=${productId}`,
    );
  }

  return mapSetActive(json);
}
