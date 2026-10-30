/**
 * Product Metafield 조회 서비스
 * Shopify Admin API를 통해 product의 travel namespace metafield를 조회합니다.
 */

import { normalizeBlackoutDates, normalizeWeekdays, parseJsonMetafield } from "./metafieldUtils";
import { getCachedProductMetafields, setCachedProductMetafields } from "./productMetafieldCache";
import { PRODUCT_NS, PRODUCT_KEYS } from "./metafieldKeys";
import { loadOfflineSession, normalizeShopDomain } from "../../lib/shopifySession";

/**
 * Product Travel Config (travel namespace metafields)
 */
export interface ProductTravelConfig {
  maxPax?: number;
  bookingWindowDays?: number;
  operatingWeekdays?: string[]; // ["monday", "tuesday", ...]
  startTimeLabel?: string;
  bookingMode?: "private" | "shared";
  guideUnitsRequired?: number;
  blackoutDates?: string[]; // YYYY-MM-DD[]
  poolKey?: string;
}

/**
 * GraphQL 쿼리: Product Metafields 조회
 */
const GET_PRODUCT_METAFIELDS_QUERY = `
  query getProductMetafields($productId: ID!) {
    product(id: $productId) {
      id
      metafields(namespace: "${PRODUCT_NS}", first: 20) {
        edges {
          node {
            namespace
            key
            value
            type
          }
        }
      }
    }
  }
`;

/**
 * Shopify productId를 GraphQL ID 형식으로 변환합니다.
 */
function toGraphQLProductId(productId: string): string {
  if (productId.startsWith("gid://")) {
    return productId;
  }
  return `gid://shopify/Product/${productId}`;
}

/**
 * Metafield 값을 파싱합니다.
 */
function parseMetafieldValue(key: string, value: string, type: string): unknown {
  if (!value) {
    return null;
  }

  // JSON 타입인 경우 파싱
  if (type === "json" || type === "list.single_line_text_field") {
    const parsed = parseJsonMetafield(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  // number_integer 타입
  if (type === "number_integer") {
    const num = Number.parseInt(value, 10);
    if (!Number.isNaN(num)) {
      return num;
    }
  }

  // 기본값: 문자열 그대로 반환
  return value;
}

/**
 * Product metafields를 파싱하여 ProductTravelConfig로 변환합니다.
 */
function parseProductMetafields(
  metafields: Array<{
    node: {
      namespace: string;
      key: string;
      value: string;
      type: string;
    };
  }>,
): ProductTravelConfig {
  const config: ProductTravelConfig = {};

  for (const edge of metafields) {
    const { key, value, type } = edge.node;

    if (!value) {
      continue;
    }

    switch (key) {
      case PRODUCT_KEYS.maxPax: {
        const parsed = parseMetafieldValue(key, value, type);
        if (typeof parsed === "number" && parsed > 0) {
          config.maxPax = parsed;
        }
        break;
      }

      case PRODUCT_KEYS.bookingWindowDays: {
        const parsed = parseMetafieldValue(key, value, type);
        if (typeof parsed === "number" && parsed >= 0) {
          config.bookingWindowDays = parsed;
        }
        break;
      }

      case PRODUCT_KEYS.operatingWeekdays: {
        const parsed = parseMetafieldValue(key, value, type);
        if (parsed !== null) {
          // list 또는 string 모두 처리
          const normalized = Array.isArray(parsed)
            ? normalizeWeekdays(parsed)
            : normalizeWeekdays(String(parsed));
          if (normalized.length > 0) {
            config.operatingWeekdays = normalized;
          }
        }
        break;
      }

      case PRODUCT_KEYS.startTimeLabel: {
        const parsed = parseMetafieldValue(key, value, type);
        if (typeof parsed === "string" && parsed.trim().length > 0) {
          config.startTimeLabel = parsed.trim();
        }
        break;
      }

      case PRODUCT_KEYS.bookingMode: {
        const parsed = parseMetafieldValue(key, value, type);
        const mode = String(parsed).toLowerCase().trim();
        if (mode === "private" || mode === "shared") {
          config.bookingMode = mode;
        }
        break;
      }

      case PRODUCT_KEYS.guideUnitsRequired: {
        const parsed = parseMetafieldValue(key, value, type);
        if (typeof parsed === "number" && parsed >= 1 && parsed <= 10) {
          config.guideUnitsRequired = parsed;
        }
        break;
      }

      case PRODUCT_KEYS.blackoutDates: {
        const parsed = parseMetafieldValue(key, value, type);
        if (parsed !== null) {
          // list 또는 string 모두 처리
          const normalized = Array.isArray(parsed)
            ? normalizeBlackoutDates(parsed)
            : normalizeBlackoutDates(String(parsed));
          if (normalized.length > 0) {
            config.blackoutDates = normalized;
          }
        }
        break;
      }

      case PRODUCT_KEYS.poolKey: {
        const parsed = parseMetafieldValue(key, value, type);
        if (typeof parsed === "string" && parsed.trim().length > 0) {
          config.poolKey = parsed.trim();
        }
        break;
      }
    }
  }

  return config;
}

/**
 * Shopify Admin API를 통해 product의 travel metafields를 조회합니다.
 * @param productId Shopify product ID
 * @param shop shop 도메인 (예: "test-shop.myshopify.com")
 * @returns Product Travel Config 또는 null (세션 없음, product 없음 등)
 * @throws Error API 실패 등
 */
export async function getProductMetafields(
  productId: string,
  shop: string,
): Promise<ProductTravelConfig | null> {
  // 캐시에서 조회
  const cached = await getCachedProductMetafields(productId, shop);
  if (cached) {
    return cached;
  }

  // 세션 로드
  const session = await loadOfflineSession(shop, {
    source: "productMetafieldService",
  });

  if (!session || !session.accessToken) {
    return null;
  }

  // GraphQL 쿼리 실행 (세션의 accessToken을 사용하여 직접 fetch)
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
      query: GET_PRODUCT_METAFIELDS_QUERY,
      variables: {
        productId: graphqlId,
      },
    }),
  });

  if (!response.ok) {
    return null;
  }

  const responseJson = (await response.json()) as any;

  // 에러 체크
  if (responseJson.errors) {
    const errorMessages = responseJson.errors.map((e: any) => e.message).join(", ");
    throw new Error(`GraphQL error: ${errorMessages}`);
  }

  const product = responseJson.data?.product;
  if (!product) {
    return null;
  }

  const metafields = product.metafields?.edges || [];
  // 파싱
  const config = parseProductMetafields(metafields);

  // 캐시에 저장
  await setCachedProductMetafields(productId, shop, config);

  return config;
}
