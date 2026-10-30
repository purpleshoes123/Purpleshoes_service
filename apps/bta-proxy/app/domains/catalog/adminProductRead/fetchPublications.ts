import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  mapPublications,
  PUBLICATIONS_QUERY,
  type PublicationDTO,
} from "~/domains/catalog/adminProductRead/publicationsQuery";

export async function fetchPublications(adminClient: AdminApiContext): Promise<PublicationDTO[]> {
  const response = await adminClient.graphql(PUBLICATIONS_QUERY, {
    variables: { first: 250, after: null },
  });

  if (!response.ok) {
    throw new Error("Shopify Admin GraphQL publications 조회 실패");
  }

  const json = await response.json();
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error: { message?: string }) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      errorMessage
        ? `Shopify Admin GraphQL publications 조회 실패: ${errorMessage}`
        : "Shopify Admin GraphQL publications 조회 실패",
    );
  }

  const publications = mapPublications(json);
  if (publications.length === 0) {
    console.warn(
      "Shopify publications 조회 결과가 비어 있습니다. Online Store 기본 체크가 적용되지 않을 수 있습니다.",
    );
  }

  return publications;
}
