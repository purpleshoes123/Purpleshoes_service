/**
 * Booking eligibility normalization and checks.
 * Shared by availability and reservations to keep consistent decisions.
 */

import { getBookingStore } from "~/domains/bookings/bookingStore";
import { isBlackoutDate } from "~/domains/bookings/blackoutService";
import { makeSlotKey } from "~/domains/bookings/bookingKeys";
import {
  resolveBookingPolicy,
  type RequestParams,
  type ResolvedBookingPolicy,
} from "~/domains/bookings/bookingConfigResolver";

export interface NormalizedBookingInput {
  productId: string;
  shop: string;
  date: string;
  pax: number;
  option?: string;
  time?: string;
  bookingMode: "private" | "shared";
  poolKey: string;
  guideUnitsRequired: number;
  slotKey: string;
  legacySlotKey?: string;
  poolDayKey?: string;
  policy: ResolvedBookingPolicy;
}

export interface EligibilityResult {
  available: boolean;
  remaining: number;
  message: string | null;
  reason: "OK" | "BLACKOUT" | "CONFIRMED" | "ACTIVE_HOLD" | "NO_CAPACITY" | "CAPACITY";
  details?: Record<string, unknown>;
}

function buildSlotKey(productId: string, date: string): string {
  // Use productId|date to match confirmed bookings and holds for private mode.
  return makeSlotKey(productId, date);
}

function buildLegacySlotKey(productId: string, date: string): string {
  // Legacy slotKey used by generateSlotKey (time/option empty).
  return `slot:${productId}:${date}::`;
}

export async function normalizeBookingInput(params: {
  productId: string;
  shop: string;
  date: string;
  pax: number;
  option?: string;
  time?: string;
  bookingMode?: "private" | "shared";
  poolKey?: string;
  guideUnitsRequired?: number;
  policy?: ResolvedBookingPolicy;
}): Promise<NormalizedBookingInput> {
  const {
    productId,
    shop,
    date,
    pax,
    option,
    time,
    bookingMode,
    poolKey,
    guideUnitsRequired,
    policy: providedPolicy,
  } = params;

  let policy: ResolvedBookingPolicy;
  if (providedPolicy) {
    policy = providedPolicy;
  } else {
    const requestParams: RequestParams = {
      bookingMode,
      poolKey,
      guideUnitsRequired,
    };
    policy = await resolveBookingPolicy(productId, shop, requestParams);
  }

  const normalizedBookingMode = policy.bookingMode;
  const normalizedPoolKey = policy.poolKey;
  const normalizedGuideUnitsRequired = policy.guideUnitsRequired;
  const slotKey = buildSlotKey(productId, date);
  const legacySlotKey = buildLegacySlotKey(productId, date);
  const poolDayKey =
    normalizedBookingMode === "shared" ? `${normalizedPoolKey}|${date}` : undefined;

  return {
    productId,
    shop,
    date,
    pax,
    option,
    time,
    bookingMode: normalizedBookingMode,
    poolKey: normalizedPoolKey,
    guideUnitsRequired: normalizedGuideUnitsRequired,
    slotKey,
    legacySlotKey,
    poolDayKey,
    policy,
  };
}

export async function checkEligibility(
  normalized: NormalizedBookingInput,
): Promise<EligibilityResult> {
  const store = getBookingStore();
  const {
    productId,
    shop,
    date,
    bookingMode,
    poolKey,
    guideUnitsRequired,
    slotKey,
    legacySlotKey,
    poolDayKey,
    policy,
  } = normalized;

  // 1. Blackout 체크
  if (await isBlackoutDate(productId, shop, date, policy)) {
    return {
      available: false,
      remaining: 0,
      message: "운영 불가 날짜입니다.",
      reason: "BLACKOUT",
    };
  }

  // 2. Private 규칙 체크
  if (bookingMode === "private") {
    const hasConfirmed = await store.hasConfirmedBooking(slotKey, shop);
    if (hasConfirmed) {
      return {
        available: false,
        remaining: 0,
        message: "이미 예약된 날짜입니다.",
        reason: "CONFIRMED",
      };
    }

    const activeHolds = await store.getActiveHoldsBySlot(slotKey);
    const legacyHolds =
      legacySlotKey && legacySlotKey !== slotKey
        ? await store.getActiveHoldsBySlot(legacySlotKey)
        : [];
    if (activeHolds.length + legacyHolds.length > 0) {
      return {
        available: false,
        remaining: 0,
        message: "예약 진행 중인 날짜입니다.",
        reason: "ACTIVE_HOLD",
        details: {
          activeHolds: activeHolds.length,
          legacyHolds: legacyHolds.length,
        },
      };
    }

    return {
      available: true,
      remaining: 1,
      message: null,
      reason: "OK",
    };
  }

  // 3. Guide Pool 판정
  const poolKeyDay = poolDayKey || `${poolKey}|${date}`;
  const confirmedUnits = await store.getPoolUsedUnits({ poolKey, date });
  const activeHolds = await store.getActiveHoldsByPool(poolKeyDay);
  const activeHoldUnits = activeHolds.reduce((sum, h) => sum + h.units, 0);
  const capacityUnits = policy.poolCapacity;

  if (capacityUnits === null) {
    return {
      available: false,
      remaining: 0,
      message: "예약 가능한 팀 수가 부족합니다.",
      reason: "NO_CAPACITY",
      details: {
        confirmedUnits,
        activeHoldUnits,
        capacityUnits,
      },
    };
  }

  const wouldExceed = confirmedUnits + activeHoldUnits + guideUnitsRequired > capacityUnits;
  if (wouldExceed) {
    return {
      available: false,
      remaining: Math.max(0, capacityUnits - confirmedUnits - activeHoldUnits),
      message: "예약 가능한 팀 수가 부족합니다.",
      reason: "CAPACITY",
      details: {
        confirmedUnits,
        activeHoldUnits,
        capacityUnits,
        guideUnitsRequired,
      },
    };
  }

  return {
    available: true,
    remaining: capacityUnits - confirmedUnits - activeHoldUnits,
    message: null,
    reason: "OK",
    details: {
      confirmedUnits,
      activeHoldUnits,
      capacityUnits,
    },
  };
}
