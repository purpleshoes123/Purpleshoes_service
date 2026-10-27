/**
 * Webhook 유틸리티
 * Phase 5-4: Shopify Webhook payload에서 예약정보 추출
 * Metafield Integration: resolver를 fallback으로 사용
 */

import { resolveBookingPolicy } from "./bookingConfigResolver";

/**
 * Line item properties에서 예약정보를 추출합니다.
 * @param lineItem Shopify line item 객체
 * @param shop shop 도메인 (resolver fallback용)
 * @returns 예약정보 또는 null (travel_date가 없으면 null)
 */
export interface BookingInfo {
  productId: string;
  travelDate: string; // YYYY-MM-DD
  bookingMode: "private" | "shared";
  poolKey: string;
  guideUnitsRequired: number;
  partySize: number;
}

export async function extractBookingInfoFromLineItem(
  lineItem: any,
  shop?: string
): Promise<BookingInfo | null> {
  // properties에서 travel_date 찾기 (필수)
  const properties = lineItem.properties || [];
  const travelDateProp = properties.find(
    (p: any) => p.name === "travel_date" || p.name === "travelDate"
  );

  if (!travelDateProp || !travelDateProp.value) {
    // travel_date가 없으면 여행상품이 아님
    return null;
  }

  const travelDate = travelDateProp.value.trim();

  // YYYY-MM-DD 형식 검증
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
    return null;
  }

  // productId 또는 productHandle
  const productId =
    lineItem.product_id?.toString() ||
    lineItem.variant_id?.toString() ||
    "";

  if (!productId) {
    return null;
  }

  // properties에서 다른 값들 추출
  const getProperty = (name: string, defaultValue: string | number) => {
    const prop = properties.find(
      (p: any) => p.name === name || p.name === name.replace("_", "")
    );
    return prop?.value || defaultValue;
  };

  let bookingMode = (getProperty("booking_mode", "private") as string).toLowerCase();
  let poolKey = (getProperty("pool_key", "DEFAULT") as string) || "DEFAULT";
  let guideUnitsRequired = Number(getProperty("guide_units_required", 1)) || 1;

  // Resolver fallback: properties에 값이 없고 shop이 있으면 resolver 사용
  if (shop && (!getProperty("booking_mode", "") || !getProperty("pool_key", "") || !getProperty("guide_units_required", ""))) {
    try {
      const policy = await resolveBookingPolicy(productId, shop, {
        bookingMode: bookingMode === "shared" ? "shared" : "private",
        poolKey,
        guideUnitsRequired,
      });
      // Resolver 결과로 보정
      bookingMode = policy.bookingMode;
      poolKey = policy.poolKey;
      guideUnitsRequired = policy.guideUnitsRequired;
    } catch (error) {
      // Resolver 실패 시 기존 값 유지
      console.warn(
        JSON.stringify({
          message: "Failed to resolve booking policy for webhook, using properties",
          productId: productId.substring(0, 20) + "...",
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  const partySize = Number(getProperty("party_size", 1)) || 1;

  return {
    productId,
    travelDate,
    bookingMode: bookingMode === "shared" ? "shared" : "private",
    poolKey,
    guideUnitsRequired: Math.max(1, Math.min(10, guideUnitsRequired)),
    partySize: Math.max(1, Math.min(20, partySize)),
  };
}

/**
 * Line item이 여행상품인지 확인합니다.
 * @param lineItem Shopify line item 객체
 * @returns travel_date가 있으면 true
 */
export async function isTravelProduct(lineItem: any, shop?: string): Promise<boolean> {
  const info = await extractBookingInfoFromLineItem(lineItem, shop);
  return info !== null;
}

