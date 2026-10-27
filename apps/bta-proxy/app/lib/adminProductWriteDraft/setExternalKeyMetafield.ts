import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  METAFIELDS_SET_MUTATION,
  mapMetafieldsSet,
} from "~/lib/adminProductWriteDraft/externalKeyMetafieldQuery";

export async function setExternalKeyMetafield(
  adminClient: AdminApiContext,
  productId: string,
  externalKey: string
): Promise<void> {
  const response = await adminClient.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: productId,
          namespace: "travel",
          key: "external_key",
          type: "single_line_text_field",
          value: externalKey,
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error(
      `external_key 세팅 실패: Shopify Admin GraphQL 요청 실패 (productId=${productId}, externalKey=${externalKey})`
    );
  }

  const payload = await response.json();
  const { userErrors, errors } = mapMetafieldsSet(payload);

  if (errors.length > 0) {
    const errorMessage = errors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `external_key 세팅 실패: ${errorMessage} (productId=${productId}, externalKey=${externalKey})`
    );
  }

  if (userErrors.length > 0) {
    const errorMessage = userErrors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `external_key 세팅 실패: ${errorMessage} (productId=${productId}, externalKey=${externalKey})`
    );
  }
}
