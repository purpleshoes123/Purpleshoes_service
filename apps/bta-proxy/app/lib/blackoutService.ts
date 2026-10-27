/**
 * Blackout 날짜 관리 서비스
 * Phase 5-2: 환경변수 기반 blackout 날짜 목록 관리
 * Metafield Integration: product.travel.blackout_dates 우선, 환경변수 fallback
 * 
 * SSOT 9.3: 상품별 blackout date 목록은 disabled-dates/availability 모두에 반영
 */

import { resolveBookingPolicy, type ResolvedBookingPolicy } from "./bookingConfigResolver";

/**
 * 상품별 blackout 날짜 목록을 가져옵니다.
 * 우선순위: product.travel.blackout_dates (metafield) → BLACKOUT_DATES_JSON (환경변수, fallback)
 * @param productId Shopify product ID
 * @param shop shop 도메인
 * @returns blackout 날짜 배열 (YYYY-MM-DD 형식)
 */
export async function getBlackoutDates(
  productId: string,
  shop: string
): Promise<string[]> {
  try {
    // Resolver를 통해 blackoutDates 가져오기
    const policy = await resolveBookingPolicy(productId, shop);
    if (policy.blackoutDates && policy.blackoutDates.length > 0) {
      return policy.blackoutDates;
    }
  } catch (error) {
    // Resolver 실패 시 fallback으로 계속 진행
    console.warn(
      JSON.stringify({
        message: "Failed to get blackout dates from metafield, falling back to env",
        productId: productId.substring(0, 20) + "...",
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }

  // Fallback: 환경변수 (개발용)
  const blackoutJson = process.env.BLACKOUT_DATES_JSON;
  if (!blackoutJson) {
    return [];
  }

  try {
    const blackoutMap: Record<string, string[]> = JSON.parse(blackoutJson);
    const fallbackDates = blackoutMap[productId] || [];
    return fallbackDates;
  } catch (error) {
    // JSON 파싱 실패 시 빈 배열 반환
    console.warn(
      JSON.stringify({
        message: "Failed to parse BLACKOUT_DATES_JSON",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return [];
  }
}

/**
 * 특정 날짜가 blackout인지 확인합니다.
 * @param productId Shopify product ID
 * @param shop shop 도메인
 * @param date 날짜 (YYYY-MM-DD 형식)
 * @param policy 정책이 이미 조회된 경우 재사용 (성능 최적화, 선택적)
 * @returns blackout 여부
 */
export async function isBlackoutDate(
  productId: string,
  shop: string,
  date: string,
  policy?: ResolvedBookingPolicy
): Promise<boolean> {
  let blackoutDates: string[];
  
  if (policy?.blackoutDates) {
    // 정책이 제공된 경우 blackoutDates 재사용
    blackoutDates = policy.blackoutDates;
  } else {
    // 정책이 제공되지 않은 경우 조회
    blackoutDates = await getBlackoutDates(productId, shop);
  }
  
  // YYYY-MM-DD 문자열 직접 비교 (Date 객체 변환 최소화)
  return blackoutDates.includes(date);
}
