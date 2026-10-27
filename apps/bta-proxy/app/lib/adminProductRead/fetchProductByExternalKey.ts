import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  mapProductsByExternalKey,
  PRODUCTS_BY_QUERY_QUERY,
  type ProductSummaryDTO,
} from "~/lib/adminProductRead/externalKeyQuery";

export async function fetchProductByExternalKey(
  adminClient: AdminApiContext,
  externalKey: string
): Promise<ProductSummaryDTO | null> {
  const response = await adminClient.graphql(PRODUCTS_BY_QUERY_QUERY, {
    variables: {
      query: "",
      first: 50,
      after: null,
    },
  });

  if (!response.ok) {
    throw new Error("external_key 조회 실패: Shopify Admin GraphQL 요청 실패");
  }

  const json = await response.json();
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error: { message?: string }) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      errorMessage
        ? `external_key 조회 실패: ${errorMessage}`
        : "external_key 조회 실패"
    );
  }

  const matches = mapProductsByExternalKey(json, externalKey);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const ids = matches.map((match) => match.id).join(", ");
    throw new Error(`external_key duplicated: matchedIds=[${ids}]`);
  }

  return matches[0];
}
