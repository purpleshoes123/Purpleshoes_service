/**
 * Variant 가격 조회 서비스
 * Phase 5-6: Shopify 상품 Variant의 Ticket Type(Adult/Child/Infant) 가격 조회
 */

import { loadOfflineSession, normalizeShopDomain } from "../../lib/shopifySession";
import { getEnv } from "../../lib/env";
import { getCachedTierVariantTable, setCachedTierVariantTable } from "./tierVariantPricingCache";
import { getTierVariantTable } from "./tierVariantPricingService";

/**
 * Variant 가격 정보
 */
export interface VariantPrices {
  adultPrice: number;
  childPrice: number;
  infantPrice: number;
  variantIds: {
    adult?: string;
    child?: string;
    infant?: string;
  };
}

export type TicketType = "adult" | "child" | "infant";

/**
 * GraphQL 쿼리: Product Variants 조회
 */
const GET_PRODUCT_VARIANTS_QUERY = `
  query getProductVariants($productId: ID!) {
    product(id: $productId) {
      id
      variants(first: 100) {
        edges {
          node {
            id
            price
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

/**
 * Shopify productId를 GraphQL ID 형식으로 변환합니다.
 * @param productId Shopify product ID (숫자 문자열)
 * @returns GraphQL ID (gid://shopify/Product/{id})
 */
function toGraphQLProductId(productId: string): string {
  // 이미 gid:// 형식이면 그대로 반환
  if (productId.startsWith("gid://")) {
    return productId;
  }
  return `gid://shopify/Product/${productId}`;
}

function normalizeVariantId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value);
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    return parts[parts.length - 1] || null;
  }
  return raw;
}

/**
 * 가격 문자열을 숫자로 변환합니다.
 * @param price 가격 문자열 (예: "100.00" 또는 "100000")
 * @returns 가격 숫자 (원 단위, 정수)
 */
function parsePrice(price: string): number {
  // 소수점 제거하고 정수로 변환 (KRW 가정)
  const num = parseFloat(price);
  if (isNaN(num)) {
    throw new Error(`Invalid price format: ${price}`);
  }
  // KRW는 소수점 없이 정수로 저장되므로 Math.round
  return Math.round(num);
}

/**
 * Variant에서 Ticket Type을 추출합니다.
 * @param selectedOptions variant의 selectedOptions 배열
 * @returns Ticket Type 값 (예: "Adult", "Child", "Infant") 또는 null
 */
function extractTicketType(selectedOptions: Array<{ name: string; value: string }>): string | null {
  const ticketTypeOption = selectedOptions.find(
    (opt) => opt.name === "Ticket Type" || opt.name === "티켓 타입",
  );

  if (!ticketTypeOption) {
    return null;
  }

  const value = ticketTypeOption.value.trim();
  // 대소문자 무시하고 매칭
  if (value.toLowerCase() === "adult" || value === "성인") {
    return "Adult";
  }
  if (value.toLowerCase() === "child" || value === "아동") {
    return "Child";
  }
  if (value.toLowerCase() === "infant" || value === "유아") {
    return "Infant";
  }

  return null;
}

/**
 * Shopify Admin API를 통해 productId의 variant 가격을 조회합니다.
 * @param productId Shopify product ID
 * @param shop shop 도메인 (예: "test-shop.myshopify.com")
 * @returns Variant 가격 정보
 * @throws Error 세션 없음, API 실패, Ticket Type variant 누락 등
 */
export async function getVariantPrices(productId: string, shop: string): Promise<VariantPrices> {
  // 세션 로드
  const session = await loadOfflineSession(shop, {
    source: "variantPricingService",
  });

  if (!session) {
    throw new Error(`Session not found for shop: ${shop}. App may not be installed.`);
  }

  if (!session.accessToken) {
    throw new Error(`Access token is missing for shop: ${shop}`);
  }

  // GraphQL 쿼리 실행
  const graphqlId = toGraphQLProductId(productId);
  // shopify.server.ts에서 사용하는 API 버전 사용
  // ApiVersion.January25는 "2025-01"에 해당
  const apiVersionString = "2025-01";
  const adminShopDomain = session.shop || normalizeShopDomain(shop);
  const graphqlUrl = `https://${adminShopDomain}/admin/api/${apiVersionString}/graphql.json`;
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: GET_PRODUCT_VARIANTS_QUERY,
      variables: {
        productId: graphqlId,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const responseJson = await response.json();

  // 에러 체크
  if (responseJson.errors) {
    const errorMessages = responseJson.errors.map((e: any) => e.message).join(", ");
    throw new Error(`GraphQL error: ${errorMessages}`);
  }

  const product = responseJson.data?.product;
  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }

  const variants = product.variants?.edges || [];

  // Ticket Type별 variant 매핑
  const variantMap: {
    adult?: { id: string; price: number };
    child?: { id: string; price: number };
    infant?: { id: string; price: number };
  } = {};

  for (const edge of variants) {
    const variant = edge.node;
    const ticketType = extractTicketType(variant.selectedOptions || []);

    if (ticketType && !variantMap[ticketType.toLowerCase() as keyof typeof variantMap]) {
      variantMap[ticketType.toLowerCase() as keyof typeof variantMap] = {
        id: variant.id,
        price: parsePrice(variant.price),
      };
    }
  }

  // 필수 variant 확인
  if (!variantMap.adult) {
    throw new Error(`Ticket Type "Adult" variant not found for product ${productId}`);
  }

  // Child와 Infant는 선택적 (없으면 0으로 처리)
  const adultPrice = variantMap.adult.price;
  const childPrice = variantMap.child?.price || 0;
  const infantPrice = variantMap.infant?.price || 0;

  return {
    adultPrice,
    childPrice,
    infantPrice,
    variantIds: {
      adult: variantMap.adult.id,
      child: variantMap.child?.id,
      infant: variantMap.infant?.id,
    },
  };
}

/**
 * Variant ID를 Ticket Type으로 매핑합니다.
 * @returns "adult" | "child" | "infant" | null
 */
export async function getTicketTypeByVariantId(params: {
  productId: string;
  shop: string;
  variantId: string | number;
}): Promise<TicketType | null> {
  const target = normalizeVariantId(params.variantId);
  if (!target) {
    return null;
  }
  // gid:// 형태도 normalizeVariantId로 숫자 id로 정규화한다.

  try {
    if (getEnv().TIER_ENABLED) {
      const cachedTierTable = await getCachedTierVariantTable(params.shop, params.productId);
      const tierTable =
        cachedTierTable ??
        (await getTierVariantTable({ productId: params.productId, shop: params.shop }));
      if (!cachedTierTable && tierTable) {
        await setCachedTierVariantTable(params.shop, params.productId, tierTable);
      }
      const tierMatch = tierTable?.byVariantId?.[target];
      if (tierMatch) {
        return tierMatch.toLowerCase() as TicketType;
      }
    }

    const { getCachedVariantPrices, setCachedVariantPrices } =
      await import("./variantPricingCache");
    let cached = await getCachedVariantPrices(params.productId);
    if (!cached) {
      cached = await getVariantPrices(params.productId, params.shop);
      await setCachedVariantPrices(params.productId, cached);
    }

    const adultId = normalizeVariantId(cached.variantIds.adult);
    const childId = normalizeVariantId(cached.variantIds.child);
    const infantId = normalizeVariantId(cached.variantIds.infant);

    if (adultId && adultId === target) {
      return "adult";
    }
    if (childId && childId === target) {
      return "child";
    }
    if (infantId && infantId === target) {
      return "infant";
    }
  } catch {
    return null;
  }

  return null;
}
