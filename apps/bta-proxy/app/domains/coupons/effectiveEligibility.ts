import type { CouponState, MediaConsentAdminOverride } from "./types";

function normalizeBalance(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function resolveEffectiveTour15Balance(params: {
  rawCreditBalance: number;
  state: Pick<CouponState, "entitledTour15" | "tour15AdminBlocked">;
}): number {
  const rawCreditBalance = normalizeBalance(params.rawCreditBalance);
  if (params.state.tour15AdminBlocked) {
    return 0;
  }
  if (params.state.entitledTour15) {
    return Math.max(1, rawCreditBalance);
  }
  return rawCreditBalance;
}

export function resolveEffectiveMediaConsent(params: {
  payloadMediaConsent: boolean;
  state: Pick<CouponState, "mediaConsentAdminOverride">;
}): boolean {
  if (params.state.mediaConsentAdminOverride === "ALLOW") {
    return true;
  }
  if (params.state.mediaConsentAdminOverride === "DENY") {
    return false;
  }
  return params.payloadMediaConsent;
}

export function isMediaConsentAdminOverride(value: unknown): value is MediaConsentAdminOverride {
  return value === "ALLOW" || value === "DENY";
}
