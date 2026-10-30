import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { fetchProductVariantsSnapshot } from "~/domains/catalog/adminVariantUpsert/fetchSnapshot";

const CHECK_PRODUCT_GATE_QUERY = `
  query checkProductGate($productId: ID!) {
    product(id: $productId) {
      id
      metafields(namespace: "travel", first: 20) {
        edges {
          node {
            namespace
            key
            value
          }
        }
      }
    }
  }
`;

type GateCheckResponse = {
  data?: {
    product?: {
      id?: string | null;
      metafields?: {
        edges?: Array<{
          node?: {
            namespace?: string | null;
            key?: string | null;
            value?: string | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

export async function canPublishProduct(
  adminClient: AdminApiContext,
  productId: string,
  maxPax: number,
): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  // 1) productId 존재 확인
  const response = await adminClient.graphql(CHECK_PRODUCT_GATE_QUERY, {
    variables: { productId },
  });

  if (!response.ok) {
    return {
      ok: false,
      reasons: [`product 조회 실패: productId=${productId}`],
    };
  }

  const json = await response.json();
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error: { message?: string }) => error.message)
      .filter(Boolean)
      .join(", ");
    return {
      ok: false,
      reasons: [`product 조회 실패: ${errorMessage}; productId=${productId}`],
    };
  }

  const product = (json as GateCheckResponse)?.data?.product;
  if (!product?.id) {
    return {
      ok: false,
      reasons: [`product가 존재하지 않습니다: productId=${productId}`],
    };
  }

  // 2) travel.external_key 존재 확인
  const metafields = product.metafields?.edges ?? [];
  const externalKeyField = metafields
    .map((edge) => edge?.node)
    .find((node) => node?.namespace === "travel" && node?.key === "external_key");
  if (!externalKeyField?.value) {
    reasons.push("travel.external_key metafield가 없습니다.");
  }

  // 3) travel.max_pax 존재 및 maxPax 파라미터와 일치 확인
  const maxPaxField = metafields
    .map((edge) => edge?.node)
    .find((node) => node?.namespace === "travel" && node?.key === "max_pax");
  if (!maxPaxField?.value) {
    reasons.push("travel.max_pax metafield가 없습니다.");
  } else {
    const metafieldMaxPax = Number(maxPaxField.value);
    if (!Number.isInteger(metafieldMaxPax) || metafieldMaxPax !== maxPax) {
      reasons.push(
        `travel.max_pax 값이 일치하지 않습니다: metafield=${metafieldMaxPax}, expected=${maxPax}`,
      );
    }
  }

  // 4) variants가 최소 3×N 존재하는지 확인
  try {
    const snapshot = await fetchProductVariantsSnapshot(adminClient, productId);
    const expectedVariants = 3 * maxPax;
    if (snapshot.variants.length < expectedVariants) {
      reasons.push(
        `variants가 부족합니다: 현재=${snapshot.variants.length}, 최소 필요=${expectedVariants} (3 × ${maxPax})`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reasons.push(`variants 조회 실패: ${message}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
