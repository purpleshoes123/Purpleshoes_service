import type { CouponState, MediaConsentAdminOverride } from "./types";
import { normalizeCustomerId } from "./normalize";
import { getCouponRedisClient } from "./redisClient";
import { stateKey } from "./keys";
import { memoryHGetAll, memoryHSet, memoryHDel } from "./memoryStore";
import {
  usesDurableCouponState,
  readDurableCouponState,
  patchDurableCouponState,
  clearDurableCouponFields,
} from "./durableState.server.ts";

function parseBool(value?: string | null): boolean {
  return value === "1" || value === "true";
}

function parseNumber(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseStringArray(value?: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return Array.from(
      new Set(parsed.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)),
    );
  } catch {
    return [];
  }
}

function parseMediaConsentAdminOverride(value?: string | null): MediaConsentAdminOverride | null {
  if (value === "ALLOW" || value === "DENY") {
    return value;
  }
  return null;
}

function toStringValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}

export async function getState(customerIdRaw: string): Promise<CouponState> {
  const customerId = normalizeCustomerId(customerIdRaw);
  if (!customerId) {
    throw new Error("customerId is required");
  }

  const key = stateKey(customerId);
  const durable = usesDurableCouponState();
  const client = durable ? null : getCouponRedisClient();
  let data: Record<string, string> = {};

  if (durable) {
    data = await readDurableCouponState(key);
  } else if (client) {
    data = await client.hgetall(key);
  } else {
    data = memoryHGetAll(key);
  }

  return {
    webRegisteredAt: parseNumber(data.webRegisteredAt),
    webMemberTagSynced: parseBool(data.webMemberTagSynced),
    webRegistrationMailComplete: parseBool(data.webRegistrationMailComplete),
    webRegistrationKlaviyoComplete: parseBool(data.webRegistrationKlaviyoComplete),
    guide50RecoveryCode: data.guide50RecoveryCode || null,
    guide50RecoveryEvidence: data.guide50RecoveryEvidence || null,
    guide50RecoveryStartedAt: parseNumber(data.guide50RecoveryStartedAt),
    guide50RecoveryCompleted: parseBool(data.guide50RecoveryCompleted),
    guide50RegisteredAt: parseNumber(data.guide50RegisteredAt),
    guide50RegistrationIssued: parseBool(data.guide50RegistrationIssued),
    entitledTour15: parseBool(data.entitledTour15),
    tour15GuideBundleOrderIds: parseStringArray(data.tour15GuideBundleOrderIds),
    tour15RevokedGuideBundleOrderIds: parseStringArray(data.tour15RevokedGuideBundleOrderIds),
    tour15TourReviewActive: parseBool(data.tour15TourReviewActive),
    tour15AdminBlocked: parseBool(data.tour15AdminBlocked),
    tour15AdminBlockedAt: parseNumber(data.tour15AdminBlockedAt),
    tour15AdminBlockedBy: data.tour15AdminBlockedBy || null,
    tour15AdminBlockedReason: data.tour15AdminBlockedReason || null,
    tour15AdminGrantedAt: parseNumber(data.tour15AdminGrantedAt),
    tour15AdminGrantedBy: data.tour15AdminGrantedBy || null,
    tour15AdminGrantedReason: data.tour15AdminGrantedReason || null,
    tour15AdminRevokedAt: parseNumber(data.tour15AdminRevokedAt),
    tour15AdminRevokedBy: data.tour15AdminRevokedBy || null,
    tour15AdminRevokedReason: data.tour15AdminRevokedReason || null,
    mediaConsent: parseBool(data.mediaConsent),
    mediaConsentAdminOverride: parseMediaConsentAdminOverride(data.mediaConsentAdminOverride),
    mediaConsentAdminOverrideAt: parseNumber(data.mediaConsentAdminOverrideAt),
    mediaConsentAdminOverrideBy: data.mediaConsentAdminOverrideBy || null,
    mediaConsentAdminOverrideReason: data.mediaConsentAdminOverrideReason || null,
    guide50Code: data.guide50Code || null,
    guide50IssuedAt: parseNumber(data.guide50IssuedAt),
    guide50ExpiresAt: parseNumber(data.guide50ExpiresAt),
    guide50DiscountId: data.guide50DiscountId || null,
    guide50ConsumedCode: data.guide50ConsumedCode || null,
    guide50ConsumedIssuedAt: parseNumber(data.guide50ConsumedIssuedAt),
    guide50ConsumedExpiresAt: parseNumber(data.guide50ConsumedExpiresAt),
    guide50ConsumedDiscountId: data.guide50ConsumedDiscountId || null,
    guide50ConsumedOrderId: data.guide50ConsumedOrderId || null,
    guide50ConsumedAt: parseNumber(data.guide50ConsumedAt),
    extra10Issued: parseBool(data.extra10Issued),
    extra10Code: data.extra10Code || null,
    extra10IssuedAt: parseNumber(data.extra10IssuedAt),
    extra10DiscountId: data.extra10DiscountId || null,
    extra10ShareActivated: parseBool(data.extra10ShareActivated),
    extra10ShareActivatedAt: parseNumber(data.extra10ShareActivatedAt),
    tourCompletedAt: parseNumber(data.tourCompletedAt),
    reviewCompletedAt: parseNumber(data.reviewCompletedAt),
  };
}

export async function patchState(
  customerIdRaw: string,
  patch: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
  const customerId = normalizeCustomerId(customerIdRaw);
  if (!customerId) {
    throw new Error("customerId is required");
  }

  const key = stateKey(customerId);
  const payload: Record<string, string> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      continue;
    }
    payload[field] = toStringValue(value);
  }
  if (Object.keys(payload).length === 0) {
    return;
  }

  if (usesDurableCouponState()) {
    await patchDurableCouponState(key, payload);
    return;
  }
  const client = getCouponRedisClient();
  if (client) {
    await client.hset(key, payload);
  } else {
    memoryHSet(key, payload);
  }
}

export async function clearStateFields(customerIdRaw: string, fields: string[]): Promise<void> {
  const customerId = normalizeCustomerId(customerIdRaw);
  if (!customerId) {
    throw new Error("customerId is required");
  }

  if (fields.length === 0) {
    return;
  }

  const key = stateKey(customerId);
  if (usesDurableCouponState()) {
    await clearDurableCouponFields(key, fields);
    return;
  }
  const client = getCouponRedisClient();
  if (client) {
    await client.hdel(key, ...fields);
  } else {
    memoryHDel(key, fields);
  }
}

export async function setEntitledTour15(customerId: string, enabled: boolean): Promise<void> {
  await patchState(customerId, { entitledTour15: enabled ? "1" : "0" });
}

export async function setMediaConsent(customerId: string, enabled: boolean): Promise<void> {
  await patchState(customerId, { mediaConsent: enabled ? "1" : "0" });
}

export async function setGuide50Fields(
  customerId: string,
  params: {
    code: string;
    issuedAt: number;
    expiresAt: number;
    discountId?: string | null;
  },
): Promise<void> {
  await patchState(customerId, {
    guide50Code: params.code,
    guide50IssuedAt: params.issuedAt,
    guide50ExpiresAt: params.expiresAt,
    ...(params.discountId ? { guide50DiscountId: params.discountId } : {}),
  });
}

export async function setGuide50ConsumedFields(
  customerId: string,
  params: {
    code: string;
    issuedAt: number;
    expiresAt: number;
    consumedAt: number;
    orderId: string;
    discountId?: string | null;
  },
): Promise<void> {
  await patchState(customerId, {
    guide50ConsumedCode: params.code,
    guide50ConsumedIssuedAt: params.issuedAt,
    guide50ConsumedExpiresAt: params.expiresAt,
    guide50ConsumedAt: params.consumedAt,
    guide50ConsumedOrderId: params.orderId,
    ...(params.discountId ? { guide50ConsumedDiscountId: params.discountId } : {}),
  });
}

export async function clearGuide50Fields(customerId: string): Promise<void> {
  await clearStateFields(customerId, [
    "guide50Code",
    "guide50IssuedAt",
    "guide50ExpiresAt",
    "guide50DiscountId",
  ]);
}

export async function clearGuide50ConsumedFields(customerId: string): Promise<void> {
  await clearStateFields(customerId, [
    "guide50ConsumedCode",
    "guide50ConsumedIssuedAt",
    "guide50ConsumedExpiresAt",
    "guide50ConsumedDiscountId",
    "guide50ConsumedOrderId",
    "guide50ConsumedAt",
  ]);
}

export async function setExtra10Fields(
  customerId: string,
  params: {
    code: string;
    issuedAt: number;
    discountId?: string | null;
  },
): Promise<void> {
  await patchState(customerId, {
    extra10Issued: "1",
    extra10Code: params.code,
    extra10IssuedAt: params.issuedAt,
    ...(params.discountId ? { extra10DiscountId: params.discountId } : {}),
  });
}

export async function clearExtra10Fields(customerId: string): Promise<void> {
  await clearStateFields(customerId, [
    "extra10Issued",
    "extra10Code",
    "extra10IssuedAt",
    "extra10DiscountId",
  ]);
}

export async function setExtra10ShareActivated(
  customerId: string,
  activatedAt: number,
): Promise<void> {
  await patchState(customerId, {
    extra10ShareActivated: "1",
    extra10ShareActivatedAt: activatedAt,
  });
}

export async function setTourCompletedAt(customerId: string, completedAt: number): Promise<void> {
  await patchState(customerId, { tourCompletedAt: completedAt });
}

export async function setReviewCompletedAt(customerId: string, completedAt: number): Promise<void> {
  await patchState(customerId, { reviewCompletedAt: completedAt });
}
