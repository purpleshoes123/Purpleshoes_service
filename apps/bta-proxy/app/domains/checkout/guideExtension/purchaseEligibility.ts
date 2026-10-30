import type { CustomerEntitlements } from "./customerMetafields";
import type { EntitlementType } from "./types";
import { GUIDE_EXTENSION_TYPES } from "./types";
import { isActive, normalizeToKstEndOfDay } from "./date";

export type GuideBasePurchaseEligibilityReason =
  | "NO_ACTIVE_ENTITLEMENT"
  | "ACTIVE_ENTITLEMENT_EXISTS";

export type GuideBasePurchaseAction = "BUY_BASE" | "EXTEND_ONLY";

export type ActiveGuideEntitlement = {
  type: EntitlementType;
  expiresAtKst: string;
};

export type GuideBasePurchaseEligibility = {
  requestedVariantId: string;
  requestedType: EntitlementType;
  canPurchaseBase: boolean;
  reason: GuideBasePurchaseEligibilityReason;
  activeEntitlements: ActiveGuideEntitlement[];
  latestActiveExpiresAtKst: string | null;
  nextAction: {
    type: GuideBasePurchaseAction;
    extensionEligibleTypes: EntitlementType[];
  };
};

function compareIsoDesc(left: string, right: string): number {
  return new Date(right).getTime() - new Date(left).getTime();
}

function toActiveEntitlement(
  type: EntitlementType,
  entitlements: CustomerEntitlements,
  now: Date,
): ActiveGuideEntitlement | null {
  const raw = entitlements[type] ?? null;
  if (!raw) {
    return null;
  }

  try {
    const expiresAtKst = normalizeToKstEndOfDay(raw);
    if (!isActive(expiresAtKst, now)) {
      return null;
    }
    return { type, expiresAtKst };
  } catch {
    return null;
  }
}

export function listActiveGuideEntitlements(
  entitlements: CustomerEntitlements,
  now: Date = new Date(),
): ActiveGuideEntitlement[] {
  return GUIDE_EXTENSION_TYPES.map((type) => toActiveEntitlement(type, entitlements, now)).filter(
    (item): item is ActiveGuideEntitlement => Boolean(item),
  );
}

export function evaluateGuideBasePurchaseEligibility(args: {
  requestedVariantId: string;
  requestedType: EntitlementType;
  entitlements: CustomerEntitlements;
  now?: Date;
}): GuideBasePurchaseEligibility {
  const now = args.now || new Date();
  const activeEntitlements = listActiveGuideEntitlements(args.entitlements, now);
  const canPurchaseBase = activeEntitlements.length === 0;
  const latestActiveExpiresAtKst = canPurchaseBase
    ? null
    : [...activeEntitlements].sort((left, right) =>
        compareIsoDesc(left.expiresAtKst, right.expiresAtKst),
      )[0]?.expiresAtKst || null;

  return {
    requestedVariantId: args.requestedVariantId,
    requestedType: args.requestedType,
    canPurchaseBase,
    reason: canPurchaseBase ? "NO_ACTIVE_ENTITLEMENT" : "ACTIVE_ENTITLEMENT_EXISTS",
    activeEntitlements,
    latestActiveExpiresAtKst,
    nextAction: {
      type: canPurchaseBase ? "BUY_BASE" : "EXTEND_ONLY",
      extensionEligibleTypes: activeEntitlements.map((item) => item.type),
    },
  };
}
