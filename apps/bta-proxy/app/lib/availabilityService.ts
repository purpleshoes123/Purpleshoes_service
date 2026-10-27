/**
 * 공통 Availability 서비스
 * availability 로직을 재사용 가능한 서비스로 추출
 * Phase 5-2에서 private/pool/blackout 로직 확장 가능하도록 설계
 * Metafield Integration: resolver를 통해 정책 결정
 */

import type { AvailabilityResult } from "~/lib/bookingStore";
import { type ResolvedBookingPolicy } from "~/lib/bookingConfigResolver";
import { checkEligibility, normalizeBookingInput } from "~/lib/bookingEligibility";

/**
 * Availability 체크 파라미터
 */
export interface AvailabilityCheckParams {
  productId: string;
  shop: string; // shop 도메인 (metafield 조회용)
  date: string; // YYYY-MM-DD
  pax: number;
  bookingMode?: "private" | "shared";
  poolKey?: string;
  guideUnitsRequired?: number;
  option?: string;
  time?: string;
  policy?: ResolvedBookingPolicy; // 정책이 이미 조회된 경우 재사용 (성능 최적화)
}

/**
 * Availability를 체크합니다.
 * 
 * Phase 5-2: blackout 판정 로직 추가 완료
 * Phase 5-3: private/pool 로직 추가 완료
 * Phase 5-5: active holds 반영 완료
 * Metafield Integration: resolver를 통해 정책 결정
 * 
 * @param params Availability 체크 파라미터
 * @returns Availability 결과
 */
export async function checkAvailability(
  params: AvailabilityCheckParams
): Promise<AvailabilityResult> {
  const normalized = await normalizeBookingInput({
    productId: params.productId,
    shop: params.shop,
    date: params.date,
    pax: params.pax,
    option: params.option,
    time: params.time,
    bookingMode: params.bookingMode,
    poolKey: params.poolKey,
    guideUnitsRequired: params.guideUnitsRequired,
    policy: params.policy,
  });

  const eligibility = await checkEligibility(normalized);

  return {
    available: eligibility.available,
    remaining: eligibility.remaining,
    cutoffMinutes: 30, // SSOT 기본값
    message: eligibility.message,
  };
}
