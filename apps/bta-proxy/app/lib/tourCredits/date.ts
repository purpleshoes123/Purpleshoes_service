import { compareDates } from "~/lib/dateUtils";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: string | null | undefined): value is string {
  if (!value) return false;
  return DATE_ONLY_REGEX.test(value.trim());
}

export function normalizeDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return isDateOnly(trimmed) ? trimmed : null;
}

export function getKstTodayDateString(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

export function isDateOnOrBefore(date: string, compareTo: string): boolean {
  return compareDates(date, compareTo) <= 0;
}
