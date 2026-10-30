import { normalizeCode } from "../normalize";
import type { CouponKind, TourPercentCode } from "../types";

const TOUR_CODES: TourPercentCode[] = ["TOUR5", "TOUR15", "TOUR20"];

export function getTourCodeKind(code: string): TourPercentCode | null {
  const normalized = normalizeCode(code);
  if (!normalized) {
    return null;
  }
  for (const kind of TOUR_CODES) {
    if (normalized.startsWith(kind)) {
      return kind;
    }
  }
  return null;
}

export function isExtra10Code(code: string): boolean {
  const normalized = normalizeCode(code);
  return Boolean(normalized && normalized.startsWith("EXTRA10"));
}

export function isGuide50Code(code: string): boolean {
  const normalized = normalizeCode(code);
  return Boolean(normalized && normalized.startsWith("GUIDE50"));
}

export function getCouponKindFromCode(code: string): CouponKind | null {
  const tourKind = getTourCodeKind(code);
  if (tourKind) {
    return tourKind;
  }
  if (isExtra10Code(code)) {
    return "EXTRA10";
  }
  if (isGuide50Code(code)) {
    return "GUIDE50";
  }
  return null;
}
