/**
 * Metafield 유틸리티
 * Metafield 값 정규화 및 파싱 함수
 */

/**
 * Blackout dates를 정규화합니다.
 * Shopify metafield에서 list 또는 single_line_text_field로 들어올 수 있으므로
 * 다양한 형식을 처리합니다.
 * @param value 문자열 또는 문자열 배열
 * @returns 정규화된 날짜 배열 (YYYY-MM-DD 형식)
 */
export function normalizeBlackoutDates(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    // 이미 배열이면 그대로 사용 (trim 및 검증)
    return value.map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  }

  // 문자열인 경우: 구분자(쉼표, bullet(•), 공백/개행) 처리
  const normalized = value
    .split(/[,\n\r•\s]+/) // 쉼표, 개행, bullet, 공백으로 분리
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d));

  return normalized;
}

/**
 * Operating weekdays를 정규화합니다.
 * Shopify metafield에서 list 또는 single_line_text_field로 들어올 수 있으므로
 * 다양한 형식을 처리합니다.
 * @param value 문자열 또는 문자열 배열
 * @returns 정규화된 요일 배열 (소문자: "monday", "tuesday", ...)
 */
export function normalizeWeekdays(value: string | string[]): string[] {
  const weekdayMap: Record<string, string> = {
    monday: "monday",
    tuesday: "tuesday",
    wednesday: "wednesday",
    thursday: "thursday",
    friday: "friday",
    saturday: "saturday",
    sunday: "sunday",
    mon: "monday",
    tue: "tuesday",
    wed: "wednesday",
    thu: "thursday",
    fri: "friday",
    sat: "saturday",
    sun: "sunday",
    월: "monday",
    화: "tuesday",
    수: "wednesday",
    목: "thursday",
    금: "friday",
    토: "saturday",
    일: "sunday",
  };

  let rawValues: string[];

  if (Array.isArray(value)) {
    rawValues = value;
  } else {
    // 문자열인 경우: 구분자(쉼표, bullet, 공백/개행) 처리
    rawValues = value
      .split(/[,\n\r•\s]+/)
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
  }

  // 정규화: 소문자 변환 후 매핑
  const normalized = rawValues
    .map((d) => d.toLowerCase().trim())
    .map((d) => weekdayMap[d] || null)
    .filter((d): d is string => d !== null);

  // 중복 제거
  return Array.from(new Set(normalized));
}

/**
 * JSON metafield 값을 파싱합니다.
 * @param value JSON 문자열
 * @returns 파싱된 값 또는 null (파싱 실패 시)
 */
export function parseJsonMetafield(value: string): unknown {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
