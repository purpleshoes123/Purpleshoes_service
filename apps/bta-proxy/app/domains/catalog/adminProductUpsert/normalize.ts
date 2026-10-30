import type { TravelProductUpsertInput, Weekday } from "./types";

const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const HANDLE_FALLBACK = "travel";

const slugifyTitle = (title: string): string => {
  const cleaned = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : HANDLE_FALLBACK;
};

export const normalizeWeekdays = (weekdays: Weekday[]): Weekday[] => {
  const set = new Set(weekdays);
  return WEEKDAY_ORDER.filter((day) => set.has(day));
};

export const normalizeBlackoutDates = (dates: string[]): string[] => {
  const trimmed = dates.map((value) => value.trim());
  const unique = Array.from(new Set(trimmed));
  return unique.sort();
};

// Normalize only after schema validation passes.
export const normalizeUpsertInput = (
  input: TravelProductUpsertInput,
): TravelProductUpsertInput => ({
  ...input,
  operatingWeekdays: normalizeWeekdays(input.operatingWeekdays),
  blackoutDates: normalizeBlackoutDates(input.blackoutDates),
});

export const generateHandleCandidate = (
  title: string,
  timestamp: number,
  suffix?: number,
): string => {
  const base = `${slugifyTitle(title)}-${timestamp}`;
  if (!suffix) {
    return base;
  }
  return `${base}-${suffix}`;
};
