/**
 * Booking Config Resolver
 * Product 및 Shop metafield를 로드하고 우선순위 규칙에 따라 최종 정책을 결정합니다.
 */

import { getProductMetafields } from "../catalog/productMetafieldService";
import { getShopMetafields, type ShopBookingConfig } from "../catalog/shopMetafieldService";

/**
 * 요청 파라미터 (선택적, resolver 결과를 덮어쓸 수 있음)
 */
export interface RequestParams {
  bookingMode?: "private" | "shared";
  poolKey?: string;
  guideUnitsRequired?: number;
}

/**
 * Resolved Booking Policy (최종 결정된 정책)
 */
export interface ResolvedBookingPolicy {
  // Pool/Booking 설정
  poolKey: string;
  bookingMode: "private" | "shared";
  guideUnitsRequired: number;
  poolCapacity: number | null; // null이면 예약 불가 (보수적 처리)

  // Product 설정
  maxPax?: number;
  bookingWindowDays?: number;
  operatingWeekdays?: string[];
  startTimeLabel?: string;
  blackoutDates?: string[];

  // Shop 설정
  poolsLabel?: Record<string, string>;
}

/**
 * Pool capacity를 결정합니다.
 * 우선순위:
 * 1. shop.booking.pools_capacity_json[poolKey] (숫자면)
 * 2. 없거나 숫자가 아니면: null 반환 (예약 불가 처리)
 * 3. 개발 환경 fallback은 명시적 ENV로만 허용
 */
function resolvePoolCapacity(
  poolKey: string,
  shopConfig: ShopBookingConfig,
  fallbackEnabled: boolean,
): number | null {
  // 1. shop.booking.pools_capacity_json[poolKey] 확인
  if (shopConfig.poolsCapacity && shopConfig.poolsCapacity[poolKey]) {
    const capacity = shopConfig.poolsCapacity[poolKey];
    if (typeof capacity === "number" && capacity > 0) {
      return capacity;
    }
  }

  // 2. 없거나 숫자가 아니면 null (예약 불가)
  // 개발 환경 fallback은 명시적 ENV로만 허용
  if (fallbackEnabled) {
    const defaultCapacity = Number(process.env.GUIDE_POOL_CAPACITY_DEFAULT);
    if (defaultCapacity && defaultCapacity > 0) {
      return defaultCapacity;
    }
  }

  return null; // 예약 불가
}

/**
 * Booking Policy를 결정합니다.
 *
 * 우선순위 규칙:
 * 1. poolKey: product.travel.pool_key → shop.booking.default_pool_key → "DEFAULT"
 * 2. guideUnitsRequired: product.travel.guide_units_required → shop.booking.default_guide_units_required → 1
 * 3. pool capacity: shop.booking.pools_capacity_json[poolKey] → null (예약 불가)
 * 4. bookingMode: product.travel.booking_mode → 요청 파라미터 → "private"
 * 5. blackoutDates: product.travel.blackout_dates → BLACKOUT_DATES_JSON (fallback, 개발용)
 * 6. maxPax / bookingWindowDays / operatingWeekdays: 모두 product.travel.*에서 읽음
 *
 * @param productId Shopify product ID
 * @param shop shop 도메인
 * @param requestParams 요청 파라미터 (선택적)
 * @returns Resolved Booking Policy
 */
export async function resolveBookingPolicy(
  productId: string,
  shop: string,
  requestParams?: RequestParams,
): Promise<ResolvedBookingPolicy> {
  // Product 및 Shop metafield 로드
  const [productConfig, shopConfig] = await Promise.all([
    getProductMetafields(productId, shop),
    getShopMetafields(shop),
  ]);

  // Fallback 활성화 여부 (개발용)
  const fallbackEnabled = process.env.METAFIELD_FALLBACK_ENABLED === "true";

  // 1. poolKey 결정
  const poolKey =
    productConfig?.poolKey || shopConfig?.defaultPoolKey || requestParams?.poolKey || "DEFAULT";

  // 2. guideUnitsRequired 결정
  const guideUnitsRequired =
    productConfig?.guideUnitsRequired ??
    shopConfig?.defaultGuideUnitsRequired ??
    requestParams?.guideUnitsRequired ??
    1;

  // 3. pool capacity 결정
  const poolCapacity = resolvePoolCapacity(poolKey, shopConfig || {}, fallbackEnabled);

  // 4. bookingMode 결정
  const bookingMode = productConfig?.bookingMode || requestParams?.bookingMode || "private";

  // 5. blackoutDates 결정
  let blackoutDates: string[] | undefined = productConfig?.blackoutDates;
  if (!blackoutDates && fallbackEnabled) {
    // Fallback: BLACKOUT_DATES_JSON 환경변수
    const blackoutJson = process.env.BLACKOUT_DATES_JSON;
    if (blackoutJson) {
      try {
        const blackoutMap: Record<string, string[]> = JSON.parse(blackoutJson);
        blackoutDates = blackoutMap[productId];
      } catch {
        // JSON 파싱 실패 시 무시
      }
    }
  }

  // 6. 기타 product 설정
  const maxPax = productConfig?.maxPax;
  const bookingWindowDays = productConfig?.bookingWindowDays;
  const operatingWeekdays = productConfig?.operatingWeekdays;
  const startTimeLabel = productConfig?.startTimeLabel;

  // 7. Shop 설정
  const poolsLabel = shopConfig?.poolsLabel;

  return {
    poolKey,
    bookingMode,
    guideUnitsRequired,
    poolCapacity,
    maxPax,
    bookingWindowDays,
    operatingWeekdays,
    startTimeLabel,
    blackoutDates,
    poolsLabel,
  };
}
