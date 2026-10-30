/**
 * Shop Metafield 조회 서비스
 * Shopify Admin API를 통해 shop의 booking namespace metafield를 조회합니다.
 */

import { parseJsonMetafield } from "./metafieldUtils";
import { getCachedShopMetafields, setCachedShopMetafields } from "./shopMetafieldCache";
import { SHOP_NS, SHOP_KEYS } from "./metafieldKeys";
import { loadOfflineSession, normalizeShopDomain } from "../../lib/shopifySession";

/**
 * Shop Booking Config (booking namespace metafields)
 */
export interface ShopBookingConfig {
  defaultPoolKey?: string;
  poolsCapacity?: Record<string, number>; // { "POOL_1": 5, "POOL_2": 10 }
  poolsLabel?: Record<string, string>; // { "POOL_1": "가이드팀 1", "POOL_2": "가이드팀 2" }
  defaultGuideUnitsRequired?: number;
}

/**
 * GraphQL 쿼리: Shop Metafields 조회
 */
const GET_SHOP_METAFIELDS_QUERY = `
  query getShopMetafields {
    shop {
      metafields(namespace: "${SHOP_NS}", first: 20) {
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
 * Metafield 값을 파싱합니다.
 */
function parseMetafieldValue(key: string, value: string, type: string): unknown {
  if (!value) {
    return null;
  }

  // JSON 타입인 경우 파싱
  if (type === "json") {
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
 * Shop metafields를 파싱하여 ShopBookingConfig로 변환합니다.
 */
function parseShopMetafields(
  metafields: Array<{
    node: {
      namespace: string;
      key: string;
      value: string;
      type: string;
    };
  }>,
): ShopBookingConfig {
  const config: ShopBookingConfig = {};

  for (const edge of metafields) {
    const { key, value, type } = edge.node;

    if (!value) {
      continue;
    }

    switch (key) {
      case SHOP_KEYS.defaultPoolKey: {
        const parsed = parseMetafieldValue(key, value, type);
        if (typeof parsed === "string" && parsed.trim().length > 0) {
          config.defaultPoolKey = parsed.trim();
        }
        break;
      }

      case SHOP_KEYS.poolsCapacityJson: {
        const parsed = parseMetafieldValue(key, value, type);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          // Record<string, number> 검증
          const capacity: Record<string, number> = {};
          for (const [poolKey, capacityValue] of Object.entries(parsed)) {
            if (typeof capacityValue === "number" && capacityValue > 0) {
              capacity[poolKey] = capacityValue;
            }
          }
          if (Object.keys(capacity).length > 0) {
            config.poolsCapacity = capacity;
          }
        }
        break;
      }

      case SHOP_KEYS.poolsLabelJson: {
        const parsed = parseMetafieldValue(key, value, type);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          // Record<string, string> 검증
          const labels: Record<string, string> = {};
          for (const [poolKey, labelValue] of Object.entries(parsed)) {
            if (typeof labelValue === "string" && labelValue.trim().length > 0) {
              labels[poolKey] = labelValue.trim();
            }
          }
          if (Object.keys(labels).length > 0) {
            config.poolsLabel = labels;
          }
        }
        break;
      }

      case SHOP_KEYS.defaultGuideUnitsRequired: {
        const parsed = parseMetafieldValue(key, value, type);
        if (typeof parsed === "number" && parsed >= 1 && parsed <= 10) {
          config.defaultGuideUnitsRequired = parsed;
        }
        break;
      }
    }
  }

  return config;
}

/**
 * Shopify Admin API를 통해 shop의 booking metafields를 조회합니다.
 * @param shop shop 도메인 (예: "test-shop.myshopify.com")
 * @returns Shop Booking Config 또는 null (세션 없음 등)
 * @throws Error API 실패 등
 */
export async function getShopMetafields(shop: string): Promise<ShopBookingConfig | null> {
  // 캐시에서 조회
  const cached = await getCachedShopMetafields(shop);
  if (cached) {
    return cached;
  }

  // 세션 로드
  const session = await loadOfflineSession(shop, {
    source: "shopMetafieldService",
  });

  if (!session || !session.accessToken) {
    return null;
  }

  // GraphQL 쿼리 실행 (세션의 accessToken을 사용하여 직접 fetch)
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
      query: GET_SHOP_METAFIELDS_QUERY,
    }),
  });

  if (!response.ok) {
    return null;
  }

  const responseJson = await response.json();

  // 에러 체크
  if (responseJson.errors) {
    const errorMessages = responseJson.errors.map((e: any) => e.message).join(", ");
    throw new Error(`GraphQL error: ${errorMessages}`);
  }

  const shopData = responseJson.data?.shop;
  if (!shopData) {
    return null;
  }

  const metafields = shopData.metafields?.edges || [];

  // 파싱
  const config = parseShopMetafields(metafields);

  // 캐시에 저장
  await setCachedShopMetafields(shop, config);

  return config;
}
