import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CouponState, MediaConsentAdminOverride } from "./types";
import { clearStateFields, getState, patchState } from "./state";
import { acquireLock, releaseLock } from "./lock";
import { maskCustomerId } from "./logging";
import { normalizeCustomerId } from "./normalize";
import { isMediaConsentAdminOverride } from "./effectiveEligibility";
import { revokePendingTourCreditIfNeeded } from "~/lib/tourCredits/pendingRevoke";
import {
  fetchCustomerTourCreditBalance,
  setCustomerTourCreditBalance,
} from "~/lib/tourCredits/metafields";
import { clearCachedTour15Balance } from "~/lib/couponDisplay/tour15BalanceCache";

export type AdminEligibilityAction =
  | "revoke_current_tour15"
  | "grant_tour15_once"
  | "block_tour15"
  | "clear_tour15_block"
  | "set_media_consent_override"
  | "clear_media_consent_override";

export type AdminEligibilityStateSnapshot = {
  entitledTour15: boolean;
  tour15GuideBundleCount: number;
  tour15GuideBundleOrderIds: string[];
  tour15TourReviewActive: boolean;
  tour15AdminBlocked: boolean;
  mediaConsent: boolean;
  mediaConsentAdminOverride: MediaConsentAdminOverride | null;
};

export type AdminEligibilityControlResult = {
  action: AdminEligibilityAction;
  shop: string;
  customerId: string;
  changed: boolean;
  stateBefore: AdminEligibilityStateSnapshot;
  stateAfter: AdminEligibilityStateSnapshot;
  rawCreditBalanceBefore: number | null;
  rawCreditBalanceAfter: number | null;
  pendingRevoke?: Awaited<ReturnType<typeof revokePendingTourCreditIfNeeded>>;
  cacheCleared: boolean;
  warnings: string[];
};

export type AdminEligibilityControlParams = {
  admin: AdminApiContext;
  shop: string;
  customerId: string;
  action: AdminEligibilityAction;
  reason: string;
  actor?: string | null;
  force?: boolean;
  mediaConsentOverride?: MediaConsentAdminOverride | null;
  correlationId?: string | null;
};

const TOUR15_BLOCK_FIELDS = [
  "tour15AdminBlocked",
  "tour15AdminBlockedAt",
  "tour15AdminBlockedBy",
  "tour15AdminBlockedReason",
];

const MEDIA_CONSENT_OVERRIDE_FIELDS = [
  "mediaConsentAdminOverride",
  "mediaConsentAdminOverrideAt",
  "mediaConsentAdminOverrideBy",
  "mediaConsentAdminOverrideReason",
];

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function snapshotState(state: CouponState): AdminEligibilityStateSnapshot {
  return {
    entitledTour15: state.entitledTour15,
    tour15GuideBundleCount: state.tour15GuideBundleOrderIds.length,
    tour15GuideBundleOrderIds: [...state.tour15GuideBundleOrderIds],
    tour15TourReviewActive: state.tour15TourReviewActive,
    tour15AdminBlocked: state.tour15AdminBlocked,
    mediaConsent: state.mediaConsent,
    mediaConsentAdminOverride: state.mediaConsentAdminOverride,
  };
}

function normalizeBalance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function serializeOrderIds(orderIds: string[]): string {
  return JSON.stringify(
    Array.from(new Set(orderIds.map((id) => id.trim()).filter(Boolean))),
  );
}

function ensureReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) {
    throw new Error("ADMIN_ELIGIBILITY_REASON_REQUIRED");
  }
  return normalized;
}

async function clearTour15Cache(customerId: string): Promise<{
  cacheCleared: boolean;
  warning: string | null;
}> {
  try {
    await clearCachedTour15Balance(customerId);
    return { cacheCleared: true, warning: null };
  } catch (error) {
    return {
      cacheCleared: false,
      warning: `CACHE_CLEAR_FAILED:${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function executeRevokeCurrentTour15(params: {
  admin: AdminApiContext;
  customerId: string;
  reason: string;
  actor: string | null;
  force: boolean;
  stateBefore: CouponState;
  rawCreditBalanceBefore: number;
  warnings: string[];
}): Promise<{
  pendingRevoke?: Awaited<ReturnType<typeof revokePendingTourCreditIfNeeded>>;
  rawCreditBalanceAfter: number;
}> {
  const {
    admin,
    customerId,
    reason,
    actor,
    force,
    stateBefore,
    rawCreditBalanceBefore,
    warnings,
  } = params;
  const hasActiveSource =
    stateBefore.tour15GuideBundleOrderIds.length > 0 ||
    stateBefore.tour15TourReviewActive;

  if (hasActiveSource && !force) {
    throw new Error("ADMIN_ELIGIBILITY_ACTIVE_SOURCE_PRESENT");
  }

  const pendingRevoke = await revokePendingTourCreditIfNeeded({
    admin,
    customerId,
    reason: "admin_revoke_current_tour15",
  });
  warnings.push(...pendingRevoke.warnings);

  if (rawCreditBalanceBefore !== 0) {
    await setCustomerTourCreditBalance(admin, customerId, 0);
  }

  const timestamp = nowSeconds();
  await patchState(customerId, {
    entitledTour15: "0",
    tour15GuideBundleOrderIds: serializeOrderIds([]),
    tour15TourReviewActive: "0",
    tour15AdminRevokedAt: timestamp,
    ...(actor ? { tour15AdminRevokedBy: actor } : {}),
    tour15AdminRevokedReason: reason,
  });

  return {
    pendingRevoke,
    rawCreditBalanceAfter: 0,
  };
}

async function executeGrantTour15Once(params: {
  admin: AdminApiContext;
  customerId: string;
  reason: string;
  actor: string | null;
  rawCreditBalanceBefore: number;
}): Promise<{ rawCreditBalanceAfter: number }> {
  const { admin, customerId, reason, actor, rawCreditBalanceBefore } = params;
  const rawCreditBalanceAfter = Math.max(1, rawCreditBalanceBefore);
  if (rawCreditBalanceBefore < 1) {
    await setCustomerTourCreditBalance(admin, customerId, 1);
  }

  const timestamp = nowSeconds();
  await clearStateFields(customerId, TOUR15_BLOCK_FIELDS);
  await patchState(customerId, {
    entitledTour15: "1",
    tour15AdminGrantedAt: timestamp,
    ...(actor ? { tour15AdminGrantedBy: actor } : {}),
    tour15AdminGrantedReason: reason,
  });

  return { rawCreditBalanceAfter };
}

async function executeBlockTour15(params: {
  admin: AdminApiContext;
  customerId: string;
  reason: string;
  actor: string | null;
  warnings: string[];
}): Promise<{
  pendingRevoke: Awaited<ReturnType<typeof revokePendingTourCreditIfNeeded>>;
}> {
  const { admin, customerId, reason, actor, warnings } = params;
  const timestamp = nowSeconds();
  await patchState(customerId, {
    tour15AdminBlocked: "1",
    tour15AdminBlockedAt: timestamp,
    ...(actor ? { tour15AdminBlockedBy: actor } : {}),
    tour15AdminBlockedReason: reason,
  });

  const pendingRevoke = await revokePendingTourCreditIfNeeded({
    admin,
    customerId,
    reason: "admin_block_tour15",
  });
  warnings.push(...pendingRevoke.warnings);
  return { pendingRevoke };
}

async function executeSetMediaConsentOverride(params: {
  customerId: string;
  reason: string;
  actor: string | null;
  override: MediaConsentAdminOverride;
}): Promise<void> {
  const { customerId, reason, actor, override } = params;
  const timestamp = nowSeconds();
  await patchState(customerId, {
    mediaConsent: override === "ALLOW" ? "1" : "0",
    mediaConsentAdminOverride: override,
    mediaConsentAdminOverrideAt: timestamp,
    ...(actor ? { mediaConsentAdminOverrideBy: actor } : {}),
    mediaConsentAdminOverrideReason: reason,
  });
}

export async function runAdminEligibilityControl(
  params: AdminEligibilityControlParams,
): Promise<AdminEligibilityControlResult> {
  const reason = ensureReason(params.reason);
  const customerId = normalizeCustomerId(params.customerId);
  if (!customerId) {
    throw new Error("ADMIN_ELIGIBILITY_CUSTOMER_ID_REQUIRED");
  }

  const actor = params.actor?.trim() || null;
  const warnings: string[] = [];
  const lockName = "adminEligibilityControl";
  const locked = await acquireLock(lockName, customerId, 30);
  if (!locked) {
    throw new Error("ADMIN_ELIGIBILITY_LOCKED");
  }

  let result: AdminEligibilityControlResult | null = null;
  try {
    const stateBeforeFull = await getState(customerId);
    const rawCreditBalanceBefore =
      params.action === "set_media_consent_override" ||
      params.action === "clear_media_consent_override"
        ? null
        : normalizeBalance(
            await fetchCustomerTourCreditBalance(params.admin, customerId),
          );
    const stateBefore = snapshotState(stateBeforeFull);
    let rawCreditBalanceAfter = rawCreditBalanceBefore;
    let pendingRevoke:
      | Awaited<ReturnType<typeof revokePendingTourCreditIfNeeded>>
      | undefined;

    if (params.action === "revoke_current_tour15") {
      const revokeResult = await executeRevokeCurrentTour15({
        admin: params.admin,
        customerId,
        reason,
        actor,
        force: params.force === true,
        stateBefore: stateBeforeFull,
        rawCreditBalanceBefore: rawCreditBalanceBefore ?? 0,
        warnings,
      });
      pendingRevoke = revokeResult.pendingRevoke;
      rawCreditBalanceAfter = revokeResult.rawCreditBalanceAfter;
    } else if (params.action === "grant_tour15_once") {
      const grantResult = await executeGrantTour15Once({
        admin: params.admin,
        customerId,
        reason,
        actor,
        rawCreditBalanceBefore: rawCreditBalanceBefore ?? 0,
      });
      rawCreditBalanceAfter = grantResult.rawCreditBalanceAfter;
    } else if (params.action === "block_tour15") {
      const blockResult = await executeBlockTour15({
        admin: params.admin,
        customerId,
        reason,
        actor,
        warnings,
      });
      pendingRevoke = blockResult.pendingRevoke;
    } else if (params.action === "clear_tour15_block") {
      await clearStateFields(customerId, TOUR15_BLOCK_FIELDS);
    } else if (params.action === "set_media_consent_override") {
      if (!isMediaConsentAdminOverride(params.mediaConsentOverride)) {
        throw new Error("ADMIN_ELIGIBILITY_MEDIA_OVERRIDE_REQUIRED");
      }
      await executeSetMediaConsentOverride({
        customerId,
        reason,
        actor,
        override: params.mediaConsentOverride,
      });
    } else if (params.action === "clear_media_consent_override") {
      await clearStateFields(customerId, MEDIA_CONSENT_OVERRIDE_FIELDS);
    } else {
      throw new Error("ADMIN_ELIGIBILITY_UNKNOWN_ACTION");
    }

    const cacheResult =
      params.action === "set_media_consent_override" ||
      params.action === "clear_media_consent_override"
        ? { cacheCleared: false, warning: null }
        : await clearTour15Cache(customerId);
    if (cacheResult.warning) warnings.push(cacheResult.warning);

    const stateAfterFull = await getState(customerId);
    result = {
      action: params.action,
      shop: params.shop,
      customerId,
      changed:
        JSON.stringify(snapshotState(stateBeforeFull)) !==
          JSON.stringify(snapshotState(stateAfterFull)) ||
        rawCreditBalanceBefore !== rawCreditBalanceAfter,
      stateBefore,
      stateAfter: snapshotState(stateAfterFull),
      rawCreditBalanceBefore,
      rawCreditBalanceAfter,
      ...(pendingRevoke ? { pendingRevoke } : {}),
      cacheCleared: cacheResult.cacheCleared,
      warnings,
    };

    console.log(
      JSON.stringify({
        message: "Coupons admin eligibility control",
        action: params.action,
        shop: params.shop,
        customerIdMasked: maskCustomerId(customerId),
        reason,
        actor,
        stateBefore: result.stateBefore,
        stateAfter: result.stateAfter,
        rawCreditBalanceBefore: result.rawCreditBalanceBefore,
        rawCreditBalanceAfter: result.rawCreditBalanceAfter,
        pendingRevoke: pendingRevoke
          ? {
              checked: pendingRevoke.checked,
              revoked: pendingRevoke.revoked,
              cleared: pendingRevoke.cleared,
              codeKind: pendingRevoke.codeKind,
              skippedReason: pendingRevoke.skippedReason || null,
              warnings: pendingRevoke.warnings,
            }
          : null,
        cacheCleared: result.cacheCleared,
        warnings,
        correlationId: params.correlationId || null,
      }),
    );

    return result;
  } finally {
    await releaseLock(lockName, customerId);
  }
}
