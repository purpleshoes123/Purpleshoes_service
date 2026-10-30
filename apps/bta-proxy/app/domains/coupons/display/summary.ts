import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getState } from "~/domains/coupons/state";
import { resolveEffectiveTour15Balance } from "~/domains/coupons/effectiveEligibility";
import { isRevoked } from "~/domains/coupons/revoked";
import { resolveActiveExtra10 } from "~/domains/coupons/extra10Availability";
import { fetchCustomerTourCreditBalance } from "~/domains/checkout/tourCredits/metafields";
import { getCachedTour15Balance, setCachedTour15Balance } from "./tour15BalanceCache";
import type { SummaryDTO } from "./types";

function computeGuide50Availability(params: {
  code: string | null;
  expiresAt: number | null;
  revoked: boolean;
  nowMs: number;
}): {
  available: boolean;
  ttlSeconds: number | null;
  expiresAtMs: number | null;
} {
  const { code, expiresAt, revoked, nowMs } = params;
  if (!code || !expiresAt || revoked) {
    return { available: false, ttlSeconds: null, expiresAtMs: null };
  }

  const expiresAtMs = expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000;
  const ttlSeconds = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
  const available = ttlSeconds > 0;

  return { available, ttlSeconds, expiresAtMs };
}

function computeMaxPercentRate(balance: number): {
  rate: number;
  reason: SummaryDTO["tour"]["maxPercentReason"];
} {
  if (balance >= 1) {
    return { rate: 0.2, reason: "TOUR20_BY_CREDIT" };
  }
  return { rate: 0.05, reason: "TOUR5_BY_MEDIA" };
}

function computeExtra10ActivationState(params: {
  available: boolean;
  shareActivated: boolean;
}): SummaryDTO["coupons"]["extra10"]["activationState"] {
  if (params.available) {
    return "activated";
  }
  if (params.shareActivated) {
    return "already_used";
  }
  return "not_activated";
}

export async function buildCouponSummary(params: {
  admin: AdminApiContext;
  customerId: string;
}): Promise<SummaryDTO> {
  const { admin, customerId } = params;
  const state = await getState(customerId);
  const nowMs = Date.now();

  const guide50Revoked = state.guide50Code ? await isRevoked(customerId, state.guide50Code) : false;
  const extra10Availability = await resolveActiveExtra10({
    admin,
    customerId,
    state,
  });
  const extra10Revoked =
    extra10Availability.reason === "REVOKED" || extra10Availability.reason === "SHOPIFY_INVALID";

  const guide50Info = computeGuide50Availability({
    code: state.guide50Code,
    expiresAt: state.guide50ExpiresAt,
    revoked: guide50Revoked,
    nowMs,
  });

  const extra10Available = extra10Availability.available;
  const extra10ActivationState = computeExtra10ActivationState({
    available: extra10Available,
    shareActivated: state.extra10ShareActivated,
  });

  let creditBalance = await getCachedTour15Balance(customerId);
  let cacheHit = true;
  if (creditBalance === null) {
    cacheHit = false;
    creditBalance = await fetchCustomerTourCreditBalance(admin, customerId);
    await setCachedTour15Balance(customerId, creditBalance);
  }
  const rawCreditBalance = Math.max(0, Math.trunc(creditBalance));
  const effectiveCreditBalance = resolveEffectiveTour15Balance({
    rawCreditBalance,
    state,
  });

  const maxRate = computeMaxPercentRate(effectiveCreditBalance);

  console.log(
    JSON.stringify({
      message: "Coupon summary computed",
      customerIdMasked: customerId.slice(-4),
      extra10Available,
      extra10Reason: extra10Availability.reason || null,
      guide50Available: guide50Info.available,
      guide50TtlSeconds: guide50Info.ttlSeconds,
      tour15CreditBalance: effectiveCreditBalance,
      cacheHit,
      rawCreditBalance,
      effectiveCreditBalance,
      entitledTour15: state.entitledTour15,
      tour15AdminBlocked: state.tour15AdminBlocked,
    }),
  );

  return {
    customerId,
    currency: "USD",
    rounding: { decimals: 2, mode: "HALF_UP" },
    tour: {
      tour15CreditBalance: effectiveCreditBalance,
      maxPercentRate: maxRate.rate,
      maxPercentReason: maxRate.reason,
    },
    coupons: {
      extra10: {
        available: extra10Available,
        amount: 10,
        code: extra10Available ? extra10Availability.code : null,
        revoked: extra10Revoked,
        activationState: extra10ActivationState,
      },
      guide50: {
        available: guide50Info.available,
        percentRate: 0.5,
        code: guide50Info.available ? state.guide50Code : null,
        expiresAt: guide50Info.expiresAtMs,
        ttlSeconds: guide50Info.ttlSeconds,
        revoked: guide50Revoked,
      },
    },
    serverTime: {
      nowMs,
      tz: "Asia/Seoul",
    },
  };
}
