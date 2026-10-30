import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  formatUserErrors,
  mapPublish,
  PUBLISH_PRODUCT_MUTATION,
} from "~/domains/catalog/adminPublishProduct/publishQuery";

export async function publishProductToChannels(
  adminClient: AdminApiContext,
  productId: string,
  publicationIds: string[],
): Promise<{ publishableId: string }> {
  if (publicationIds.length === 0) {
    throw new Error(`publish할 publicationIds가 비어 있습니다: productId=${productId}`);
  }

  const response = await adminClient.graphql(PUBLISH_PRODUCT_MUTATION, {
    variables: {
      id: productId,
      input: publicationIds.map((publicationId) => ({ publicationId })),
    },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin GraphQL product publish 실패: productId=${productId}, publicationIds=[${publicationIds.join(", ")}]`,
    );
  }

  const json = await response.json();
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error: { message?: string }) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Shopify Admin GraphQL product publish 실패: ${errorMessage}; productId=${productId}, publicationIds=[${publicationIds.join(", ")}]`,
    );
  }

  const userErrors = formatUserErrors(json?.data?.publishablePublish?.userErrors ?? []);

  // 이미 게시된 경우 idempotent하게 성공 처리
  const isAlreadyPublished = userErrors.some(
    (error) =>
      error.toLowerCase().includes("already published") ||
      error.toLowerCase().includes("already exists") ||
      error.toLowerCase().includes("이미 게시"),
  );

  if (userErrors.length > 0 && !isAlreadyPublished) {
    throw new Error(
      `product publish 실패: ${userErrors.join(", ")}; productId=${productId}, publicationIds=[${publicationIds.join(", ")}]`,
    );
  }

  // 이미 게시된 경우에도 성공으로 처리 (idempotent)
  return mapPublish(json);
}
