/**
 * Group Key 유틸리티
 * Phase X: webhook과 rebuild가 동일한 groupKey 생성 규칙을 사용하도록 통합
 * 
 * 규칙: travel_date|productId|poolKey|bookingMode|holdId
 * - bookingMode 기본값: "private"
 * - poolKey 기본값: "DEFAULT"
 * - holdId가 없으면 미포함
 */

export interface CreateGroupKeyParams {
  travelDate: string; // YYYY-MM-DD
  productId: string;
  poolKey?: string;
  bookingMode?: "private" | "shared";
  holdId?: string;
}

/**
 * 그룹 키 생성
 * 형식: travel_date|productId|poolKey|bookingMode|holdId
 * 
 * @param params 그룹 키 생성 파라미터
 * @returns 그룹 키 문자열
 */
export function createGroupKey(params: CreateGroupKeyParams): string {
  const {
    travelDate,
    productId,
    poolKey = "DEFAULT",
    bookingMode = "private",
    holdId,
  } = params;

  const parts = [
    travelDate,
    productId,
    poolKey,
    bookingMode,
  ];

  // holdId가 있으면 추가
  if (holdId) {
    parts.push(holdId);
  }

  return parts.join("|");
}

