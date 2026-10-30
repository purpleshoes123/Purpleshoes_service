import { KST_END_OF_DAY, KST_OFFSET_MINUTES } from "./types";

export type DateLike = string | Date;

const TIMEZONE_REGEX = /([zZ]|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_PER_FIXED_MONTH = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Two-digit padding for KST end-of-day ISO formatting.
 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Parse Date/ISO input into a Date object with KST interpretation.
 */
function parseDateLike(dateLike: DateLike): Date {
  if (dateLike instanceof Date) {
    return new Date(dateLike.getTime());
  }

  const trimmed = dateLike.trim();
  if (!trimmed) {
    throw new Error("Invalid date input: empty string");
  }

  if (TIMEZONE_REGEX.test(trimmed)) {
    return new Date(trimmed);
  }

  if (DATE_ONLY_REGEX.test(trimmed)) {
    return new Date(`${trimmed}T00:00:00+09:00`);
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return new Date(`${trimmed}+09:00`);
  }

  return new Date(trimmed);
}

/**
 * Split Date into KST(+09:00) date parts.
 */
function getKstDateParts(date: Date): { year: number; month: number; day: number } {
  const kstMs = date.getTime() + KST_OFFSET_MINUTES * 60 * 1000;
  const kstDate = new Date(kstMs);
  return {
    year: kstDate.getUTCFullYear(),
    month: kstDate.getUTCMonth() + 1,
    day: kstDate.getUTCDate(),
  };
}

/**
 * Format ISO string in KST(+09:00).
 */
function formatKstIso(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): string {
  const { year, month, day, hour, minute, second } = args;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+09:00`;
}

/**
 * Normalize to KST end-of-day (23:59:59). Output is ISO string with +09:00.
 */
export function normalizeToKstEndOfDay(dateLike: DateLike): string {
  const date = parseDateLike(dateLike);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date input: ${String(dateLike)}`);
  }

  const { year, month, day } = getKstDateParts(date);
  return formatKstIso({
    year,
    month,
    day,
    hour: KST_END_OF_DAY.hour,
    minute: KST_END_OF_DAY.minute,
    second: KST_END_OF_DAY.second,
  });
}

/**
 * Add fixed 30-day months, then normalize to KST end-of-day.
 */
export function addFixedMonthDaysKstEndOfDay(baseExpiresAt: DateLike, months: number): string {
  const date = parseDateLike(baseExpiresAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid base date input: ${String(baseExpiresAt)}`);
  }
  if (!Number.isFinite(months)) {
    throw new Error(`Invalid months input: ${String(months)}`);
  }

  const durationMs = months * DAYS_PER_FIXED_MONTH * MS_PER_DAY;
  return normalizeToKstEndOfDay(new Date(date.getTime() + durationMs));
}

/**
 * Active rule: expiresAt > now.
 */
export function isActive(expiresAt: DateLike, now: DateLike): boolean {
  const expires = parseDateLike(expiresAt);
  const current = parseDateLike(now);
  if (Number.isNaN(expires.getTime()) || Number.isNaN(current.getTime())) {
    throw new Error("Invalid date input for active check");
  }
  return expires.getTime() > current.getTime();
}
