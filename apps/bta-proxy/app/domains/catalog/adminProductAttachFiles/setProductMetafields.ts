import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  METAFIELDS_SET_MUTATION,
  mapMetafieldsSetErrors,
} from "~/domains/catalog/adminProductAttachFiles/metafieldsSetQuery";

type MetafieldInput = {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

export async function setProductMetafields(
  adminClient: AdminApiContext,
  productId: string,
  metafields: MetafieldInput[],
): Promise<void> {
  const response = await adminClient.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields,
    },
  });

  if (!response.ok) {
    throw new Error(`metafieldsSet 실패: Shopify Admin GraphQL 요청 실패 (productId=${productId})`);
  }

  const payload = await response.json();
  const { ok, errors } = mapMetafieldsSetErrors(payload);

  if (!ok) {
    const errorMessage = errors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(`metafieldsSet 실패: ${errorMessage} (productId=${productId})`);
  }
}
