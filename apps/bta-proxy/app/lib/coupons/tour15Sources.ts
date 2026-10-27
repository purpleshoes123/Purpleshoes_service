import type { CouponState } from "./types";
import { getState, patchState } from "./state";
import { maskCustomerId } from "./logging";

export type Tour15SourceResult = {
  customerId: string;
  orderId?: string;
  sourceAdded?: boolean;
  sourceRemoved?: boolean;
  sourceRestored?: boolean;
  sourceRevoked?: boolean;
  consumedGuideBundleOrderId?: string | null;
  consumedTourReviewSource?: boolean;
  legacyEntitlementPreserved?: boolean;
  activeGuideBundleOrderIdsBefore: string[];
  activeGuideBundleOrderIdsAfter: string[];
  revokedGuideBundleOrderIdsBefore?: string[];
  revokedGuideBundleOrderIdsAfter?: string[];
  activeGuideBundleCountBefore: number;
  activeGuideBundleCountAfter: number;
  tourReviewActiveBefore: boolean;
  tourReviewActiveAfter: boolean;
  entitledTour15Before: boolean;
  entitledTour15After: boolean;
};

function normalizeOrderId(orderId: string | number | null | undefined): string {
  return String(orderId || "").trim();
}

function serializeOrderIds(orderIds: string[]): string {
  return JSON.stringify(Array.from(new Set(orderIds.map(normalizeOrderId).filter(Boolean))));
}

function computeEntitled(params: {
  guideBundleOrderIds: string[];
  tourReviewActive: boolean;
  legacyEntitlementPreserved?: boolean;
}): boolean {
  return (
    params.guideBundleOrderIds.length > 0 ||
    params.tourReviewActive ||
    params.legacyEntitlementPreserved === true
  );
}

function buildBaseResult(params: {
  state: CouponState;
  customerId: string;
  orderId?: string;
  afterOrderIds: string[];
  tourReviewActiveAfter: boolean;
  legacyEntitlementPreserved?: boolean;
}): Tour15SourceResult {
  const {
    state,
    customerId,
    orderId,
    afterOrderIds,
    tourReviewActiveAfter,
    legacyEntitlementPreserved,
  } = params;
  const entitledTour15After = computeEntitled({
    guideBundleOrderIds: afterOrderIds,
    tourReviewActive: tourReviewActiveAfter,
    legacyEntitlementPreserved,
  });

  return {
    customerId,
    orderId,
    activeGuideBundleOrderIdsBefore: state.tour15GuideBundleOrderIds,
    activeGuideBundleOrderIdsAfter: afterOrderIds,
    activeGuideBundleCountBefore: state.tour15GuideBundleOrderIds.length,
    activeGuideBundleCountAfter: afterOrderIds.length,
    tourReviewActiveBefore: state.tour15TourReviewActive,
    tourReviewActiveAfter,
    entitledTour15Before: state.entitledTour15,
    entitledTour15After,
    legacyEntitlementPreserved,
  };
}

async function persistResult(result: Tour15SourceResult): Promise<void> {
  await patchState(result.customerId, {
    tour15GuideBundleOrderIds: serializeOrderIds(result.activeGuideBundleOrderIdsAfter),
    ...(result.revokedGuideBundleOrderIdsAfter
      ? {
          tour15RevokedGuideBundleOrderIds: serializeOrderIds(
            result.revokedGuideBundleOrderIdsAfter,
          ),
        }
      : {}),
    tour15TourReviewActive: result.tourReviewActiveAfter ? "1" : "0",
    entitledTour15: result.entitledTour15After ? "1" : "0",
  });
}

export async function addGuideBundleTour15Source(
  customerId: string,
  orderId: string | number
): Promise<Tour15SourceResult> {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) {
    throw new Error("orderId is required");
  }

  const state = await getState(customerId);
  const beforeOrderIds = state.tour15GuideBundleOrderIds;
  const afterOrderIds = beforeOrderIds.includes(normalizedOrderId)
    ? beforeOrderIds
    : [...beforeOrderIds, normalizedOrderId];
  const result = buildBaseResult({
    state,
    customerId,
    orderId: normalizedOrderId,
    afterOrderIds,
    tourReviewActiveAfter: state.tour15TourReviewActive,
  });
  result.sourceAdded = afterOrderIds.length > beforeOrderIds.length;
  await persistResult(result);

  console.log(
    JSON.stringify({
      message: "Tour15 guide bundle source added",
      orderId: normalizedOrderId,
      customerIdMasked: maskCustomerId(customerId),
      sourceAdded: result.sourceAdded,
      activeGuideBundleCountBefore: result.activeGuideBundleCountBefore,
      activeGuideBundleCountAfter: result.activeGuideBundleCountAfter,
      tourReviewActive: result.tourReviewActiveAfter,
      entitledTour15Before: result.entitledTour15Before,
      entitledTour15After: result.entitledTour15After,
    })
  );

  return result;
}

export async function removeGuideBundleTour15Source(
  customerId: string,
  orderId: string | number
): Promise<Tour15SourceResult> {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) {
    throw new Error("orderId is required");
  }

  const state = await getState(customerId);
  const beforeOrderIds = state.tour15GuideBundleOrderIds;
  const afterOrderIds = beforeOrderIds.filter((id) => id !== normalizedOrderId);
  const revokedBefore = state.tour15RevokedGuideBundleOrderIds;
  const revokedAfter = revokedBefore.includes(normalizedOrderId)
    ? revokedBefore
    : [...revokedBefore, normalizedOrderId];
  const sourceRemoved = afterOrderIds.length < beforeOrderIds.length;
  const legacyEntitlementPreserved =
    !sourceRemoved &&
    beforeOrderIds.length === 0 &&
    state.entitledTour15 &&
    !state.tour15TourReviewActive;

  const result = buildBaseResult({
    state,
    customerId,
    orderId: normalizedOrderId,
    afterOrderIds,
    tourReviewActiveAfter: state.tour15TourReviewActive,
    legacyEntitlementPreserved,
  });
  result.sourceRemoved = sourceRemoved;
  result.revokedGuideBundleOrderIdsBefore = revokedBefore;
  result.revokedGuideBundleOrderIdsAfter = revokedAfter;
  await persistResult(result);

  console.log(
    JSON.stringify({
      message: "Tour15 guide bundle source removed",
      orderId: normalizedOrderId,
      customerIdMasked: maskCustomerId(customerId),
      sourceRemoved,
      activeGuideBundleCountBefore: result.activeGuideBundleCountBefore,
      activeGuideBundleCountAfter: result.activeGuideBundleCountAfter,
      revokedGuideBundleCountBefore: revokedBefore.length,
      revokedGuideBundleCountAfter: revokedAfter.length,
      tourReviewActive: result.tourReviewActiveAfter,
      legacyEntitlementPreserved,
      entitledTour15Before: result.entitledTour15Before,
      entitledTour15After: result.entitledTour15After,
    })
  );

  return result;
}

export type Tour15ConsumedSourceType =
  | "GUIDE_BUNDLE"
  | "TOUR_REVIEW"
  | "LEGACY"
  | "UNKNOWN";

export async function isGuideBundleTour15SourceRevoked(
  customerId: string,
  orderId: string | number | null | undefined,
): Promise<boolean> {
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedOrderId) return false;
  const state = await getState(customerId);
  return state.tour15RevokedGuideBundleOrderIds.includes(normalizedOrderId);
}

export async function restoreConsumedTour15Source(params: {
  customerId: string;
  sourceType: Tour15ConsumedSourceType;
  sourceOrderId?: string | null;
}): Promise<Tour15SourceResult> {
  const { customerId, sourceType } = params;
  const state = await getState(customerId);
  const sourceOrderId = normalizeOrderId(params.sourceOrderId);
  let afterOrderIds = [...state.tour15GuideBundleOrderIds];
  let tourReviewActiveAfter = state.tour15TourReviewActive;
  let sourceRestored = false;
  let sourceRevoked = false;
  let legacyEntitlementPreserved = false;

  if (sourceType === "GUIDE_BUNDLE") {
    sourceRevoked =
      Boolean(sourceOrderId) &&
      state.tour15RevokedGuideBundleOrderIds.includes(sourceOrderId);
    if (sourceOrderId && !sourceRevoked && !afterOrderIds.includes(sourceOrderId)) {
      afterOrderIds = [sourceOrderId, ...afterOrderIds];
      sourceRestored = true;
    }
  } else if (sourceType === "TOUR_REVIEW") {
    sourceRestored = !tourReviewActiveAfter;
    tourReviewActiveAfter = true;
  } else if (sourceType === "LEGACY") {
    legacyEntitlementPreserved = true;
    sourceRestored = !state.entitledTour15;
  }

  const result = buildBaseResult({
    state,
    customerId,
    orderId: sourceOrderId || undefined,
    afterOrderIds,
    tourReviewActiveAfter,
    legacyEntitlementPreserved,
  });
  result.sourceRestored = sourceRestored;
  result.sourceRevoked = sourceRevoked;
  result.revokedGuideBundleOrderIdsBefore = state.tour15RevokedGuideBundleOrderIds;
  result.revokedGuideBundleOrderIdsAfter = state.tour15RevokedGuideBundleOrderIds;

  if (sourceType !== "UNKNOWN" && !sourceRevoked) {
    await persistResult(result);
  }

  console.log(
    JSON.stringify({
      message: "Tour15 source restored",
      customerIdMasked: maskCustomerId(customerId),
      sourceType,
      sourceOrderId: sourceOrderId || null,
      sourceRestored,
      sourceRevoked,
      activeGuideBundleCountBefore: result.activeGuideBundleCountBefore,
      activeGuideBundleCountAfter: result.activeGuideBundleCountAfter,
      tourReviewActiveBefore: result.tourReviewActiveBefore,
      tourReviewActiveAfter: result.tourReviewActiveAfter,
      entitledTour15Before: result.entitledTour15Before,
      entitledTour15After: result.entitledTour15After,
    })
  );

  return result;
}

export async function grantTourReviewTour15Source(
  customerId: string
): Promise<Tour15SourceResult> {
  const state = await getState(customerId);
  const result = buildBaseResult({
    state,
    customerId,
    afterOrderIds: state.tour15GuideBundleOrderIds,
    tourReviewActiveAfter: true,
  });
  await persistResult(result);

  console.log(
    JSON.stringify({
      message: "Tour15 tour-review source granted",
      customerIdMasked: maskCustomerId(customerId),
      activeGuideBundleCount: result.activeGuideBundleCountAfter,
      tourReviewActiveBefore: result.tourReviewActiveBefore,
      tourReviewActiveAfter: result.tourReviewActiveAfter,
      entitledTour15Before: result.entitledTour15Before,
      entitledTour15After: result.entitledTour15After,
    })
  );

  return result;
}

export async function consumeOneTour15Source(
  customerId: string
): Promise<Tour15SourceResult> {
  const state = await getState(customerId);
  const afterOrderIds = [...state.tour15GuideBundleOrderIds];
  const consumedGuideBundleOrderId = afterOrderIds.shift() || null;
  const consumedTourReviewSource =
    !consumedGuideBundleOrderId && state.tour15TourReviewActive;
  const tourReviewActiveAfter = consumedTourReviewSource
    ? false
    : state.tour15TourReviewActive;

  const result = buildBaseResult({
    state,
    customerId,
    afterOrderIds,
    tourReviewActiveAfter,
  });
  result.consumedGuideBundleOrderId = consumedGuideBundleOrderId;
  result.consumedTourReviewSource = consumedTourReviewSource;
  await persistResult(result);

  console.log(
    JSON.stringify({
      message: "Tour15 source consumed",
      customerIdMasked: maskCustomerId(customerId),
      consumedGuideBundleOrderId,
      consumedTourReviewSource,
      activeGuideBundleCountBefore: result.activeGuideBundleCountBefore,
      activeGuideBundleCountAfter: result.activeGuideBundleCountAfter,
      tourReviewActiveBefore: result.tourReviewActiveBefore,
      tourReviewActiveAfter: result.tourReviewActiveAfter,
      entitledTour15Before: result.entitledTour15Before,
      entitledTour15After: result.entitledTour15After,
    })
  );

  return result;
}
