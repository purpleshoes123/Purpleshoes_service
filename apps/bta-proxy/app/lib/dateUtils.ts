/**
 * KST(Asia/Seoul) 기준 날짜 처리 유틸리티
 * SSOT 3장: 모든 날짜 계산은 Asia/Seoul(KST) 기준
 */

const KST_TIMEZONE = "Asia/Seoul";
const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || KST_TIMEZONE;

/**
 * YYYY-MM-DD 문자열을 KST 기준 Date 객체로 변환
 * 입력은 로컬 날짜로 해석 (시간은 00:00:00 KST)
 */
export function parseKSTDate(dateString: string): Date {
  // YYYY-MM-DD 형식 검증
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error(`Invalid date format: ${dateString}. Expected YYYY-MM-DD`);
  }

  // KST 기준으로 날짜 파싱
  // YYYY-MM-DD를 KST의 자정(00:00:00)으로 해석
  const [year, month, day] = dateString.split("-").map(Number);
  
  // Date 객체 생성 (로컬 시간대 기준)
  // KST는 UTC+9이므로, UTC로 변환하려면 9시간을 빼야 함
  // 하지만 YYYY-MM-DD를 로컬 날짜로 해석하므로, 그대로 사용
  const date = new Date(year, month - 1, day);
  
  // 유효성 검증
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`Invalid date: ${dateString}`);
  }

  return date;
}

/**
 * Date 객체를 YYYY-MM-DD 문자열로 변환 (KST 기준)
 */
export function formatKSTDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 날짜에 일수를 더함 (KST 기준, date-only 연산)
 * timezone 영향을 받지 않도록 date-only로 처리
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * from부터 to까지 inclusive 날짜 범위를 배열로 반환 (KST 기준)
 * @param from YYYY-MM-DD 형식의 시작 날짜
 * @param to YYYY-MM-DD 형식의 종료 날짜 (inclusive)
 * @returns YYYY-MM-DD 형식의 날짜 문자열 배열 (오름차순)
 */
export function getDateRange(from: string, to: string): string[] {
  const fromDate = parseKSTDate(from);
  const toDate = parseKSTDate(to);

  // from > to인 경우 빈 배열 반환
  if (fromDate > toDate) {
    return [];
  }

  const dates: string[] = [];
  let currentDate = new Date(fromDate);

  // inclusive: toDate까지 포함
  while (currentDate <= toDate) {
    dates.push(formatKSTDate(currentDate));
    currentDate = addDays(currentDate, 1);
  }

  return dates;
}

/**
 * 두 날짜 문자열 비교 (YYYY-MM-DD 형식)
 * @returns from이 to보다 이전이면 -1, 같으면 0, 이후면 1
 */
export function compareDates(from: string, to: string): number {
  const fromDate = parseKSTDate(from);
  const toDate = parseKSTDate(to);

  if (fromDate < toDate) return -1;
  if (fromDate > toDate) return 1;
  return 0;
}

