import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  PRODUCT_CREATE_MEDIA_MUTATION,
  mapHeroMediaResult,
} from "~/lib/adminProductAttachFiles/heroMediaQuery";

export async function attachHeroMedia(
  adminClient: AdminApiContext,
  productId: string,
  heroPreviewUrl: string
): Promise<void> {
  const response = await adminClient.graphql(PRODUCT_CREATE_MEDIA_MUTATION, {
    variables: {
      productId,
      media: [
        {
          mediaContentType: "IMAGE",
          originalSource: heroPreviewUrl,
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error(
      `hero media 연결 실패: Shopify Admin GraphQL 요청 실패 (productId=${productId})`
    );
  }

  const payload = await response.json();
  const { ok, errors } = mapHeroMediaResult(payload);

  if (!ok) {
    const errorMessage = (errors || []).filter(Boolean).join(", ");
    throw new Error(
      `hero media 연결 실패: ${errorMessage} (productId=${productId})`
    );
  }
}
