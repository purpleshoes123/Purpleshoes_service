import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CouponState } from "./types";
import { getState, patchState } from "./state";
import { listRevoked } from "./revoked";
import { fetchDiscountStatusByCode } from "./shopifyDiscounts";

export async function assertUnusedExpiredLegacyOffer(
  admin: AdminApiContext,
  customerId: string,
  state: CouponState,
  expectedCode: string,
) {
  const now = Math.floor(Date.now() / 1000);
  if (
    !expectedCode.startsWith(`GUIDE50-${customerId}-`) ||
    state.guide50Code !== expectedCode ||
    !state.guide50ExpiresAt ||
    state.guide50ExpiresAt >= now ||
    state.guide50ConsumedCode ||
    state.guide50ConsumedOrderId ||
    state.guide50ConsumedAt ||
    state.guide50RecoveryCompleted
  ) {
    throw new Error("Legacy offer is not an unused expired candidate");
  }
  if ([...(await listRevoked(customerId))].some((code) => code.startsWith("GUIDE50-"))) {
    throw new Error("Manually revoked offers cannot be recovered");
  }
  const actual = await fetchDiscountStatusByCode(admin, expectedCode);
  const actualEndsAt = actual.endsAt ? Date.parse(actual.endsAt) : NaN;
  if (
    actual.status !== "invalid" ||
    !["EXPIRED", "expired"].includes(actual.reason || "") ||
    actual.usageCount !== 0 ||
    !Number.isFinite(actualEndsAt) ||
    actualEndsAt >= Date.now()
  ) {
    throw new Error(
      "Shopify must confirm expiry and zero usage; unknown/disabled offers are not eligible",
    );
  }
}

/** Operator-only approval after checking the lead/registration history.
 * No public endpoint accepts this evidence or approval. It does not issue a
 * coupon: the 24-hour recovery window starts on the customer's next login.
 */
export async function approveLegacyRegistrationRecovery(
  admin: AdminApiContext,
  input: {
    customerId: string;
    expectedCode: string;
    evidence: string;
    apply?: boolean;
  },
) {
  if (
    !/^[1-9]\d*$/.test(input.customerId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,160}$/.test(input.evidence)
  ) {
    throw new Error("Exact customer and non-secret evidence reference required");
  }
  const state = await getState(input.customerId);
  await assertUnusedExpiredLegacyOffer(admin, input.customerId, state, input.expectedCode);
  if (
    state.guide50RecoveryStartedAt ||
    (state.guide50RecoveryCode && state.guide50RecoveryCode !== input.expectedCode)
  ) {
    throw new Error("Recovery already started or approval target changed");
  }
  if (input.apply) {
    await patchState(input.customerId, {
      guide50RecoveryCode: input.expectedCode,
      guide50RecoveryEvidence: input.evidence,
    });
  }
  return {
    eligible: true,
    approvalSaved: Boolean(input.apply),
    startsOnNextAuthenticatedVisit: true,
  };
}
