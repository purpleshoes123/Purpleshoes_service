import type { DiscountPreviewDTO } from "./types";
import { round2 } from "./rounding";

export function buildMaxDiscountPreview(params: {
  total: number;
  creditBalance: number;
  extra10Available: boolean;
  isLoggedIn: boolean;
}): DiscountPreviewDTO {
  const { total, creditBalance, extra10Available, isLoggedIn } = params;

  let maxPercentRate = 0;
  if (isLoggedIn) {
    maxPercentRate = creditBalance >= 1 ? 0.2 : 0.05;
  }

  const maxPercentAmount = round2(total * maxPercentRate);
  const extra10Amount = extra10Available ? 10 : 0;
  const maxDiscountAmount = round2(maxPercentAmount + extra10Amount);
  const maxFinalTotal = round2(total - maxDiscountAmount);

  return {
    maxPercentRate,
    maxPercentAmount,
    extra10Applied: extra10Available,
    extra10Amount,
    maxDiscountAmount,
    maxFinalTotal,
    assumptions: {
      includesExtra10IfAvailable: true,
      maxRateAssumesMediaConsent: true,
      maxRateDependsOnTour15CreditBalance: true,
    },
  };
}
