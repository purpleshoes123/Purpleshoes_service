export type SummaryDTO = {
  customerId: string;
  currency: "USD";
  rounding: { decimals: 2; mode: "HALF_UP" };
  tour: {
    tour15CreditBalance: number;
    maxPercentRate: number;
    maxPercentReason: "NONE" | "TOUR5_BY_MEDIA" | "TOUR20_BY_CREDIT";
  };
  coupons: {
    extra10: {
      available: boolean;
      amount: number;
      code: string | null;
      revoked: boolean;
      activationState: "not_activated" | "activated" | "already_used" | "ineligible";
    };
    guide50: {
      available: boolean;
      percentRate: number;
      code: string | null;
      expiresAt: number | null;
      ttlSeconds: number | null;
      revoked: boolean;
    };
  };
  serverTime: {
    nowMs: number;
    tz: "Asia/Seoul";
  };
};

export type DiscountPreviewDTO = {
  maxPercentRate: number;
  maxPercentAmount: number;
  extra10Applied: boolean;
  extra10Amount: number;
  maxDiscountAmount: number;
  maxFinalTotal: number;
  assumptions: {
    includesExtra10IfAvailable: true;
    maxRateAssumesMediaConsent: true;
    maxRateDependsOnTour15CreditBalance: true;
  };
};
