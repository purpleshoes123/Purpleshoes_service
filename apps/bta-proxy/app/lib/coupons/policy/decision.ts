import type { TourPercentCode } from "../types";

export function decideTourPercentCode(
  entitled15: boolean,
  mediaConsent: boolean
): TourPercentCode | null {
  if (!entitled15 && !mediaConsent) return null;
  if (!entitled15 && mediaConsent) return "TOUR5";
  if (entitled15 && !mediaConsent) return "TOUR15";
  return "TOUR20";
}
