/**
 * Guide Extension domain types/constants.
 * SSOT: PDF/VIDEO/BUNDLE entitlements, KST 23:59:59, 1~24 months.
 */

export type EntitlementType = "PDF" | "VIDEO" | "BUNDLE";
export type LedgerEventType = "BASE" | "EXTEND" | "REFUND";

export const GUIDE_EXTENSION_MONTHS_MIN = 1;
export const GUIDE_EXTENSION_MONTHS_MAX = 24;

export const GUIDE_EXTENSION_TYPES: EntitlementType[] = [
  "PDF",
  "VIDEO",
  "BUNDLE",
];

export const GUIDE_EXTENSION_EVENT_TYPES: LedgerEventType[] = [
  "BASE",
  "EXTEND",
  "REFUND",
];

/**
 * KST(+09:00) end-of-day policy (23:59:59).
 */
export const KST_END_OF_DAY = {
  hour: 23,
  minute: 59,
  second: 59,
} as const;

export const KST_OFFSET_MINUTES = 9 * 60;
