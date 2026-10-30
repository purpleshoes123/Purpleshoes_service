import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { revokeCode } from "~/domains/coupons/issuer";
import { maskCouponCode, maskCustomerId } from "~/domains/coupons/logging";
import { getTourCodeKind } from "~/domains/coupons/policy/codes";
import { clearTourPending, getTourPending } from "~/domains/checkout/tourCheckout/pending";

export type PendingTourCreditRevokeResult = {
  checked: boolean;
  revoked: boolean;
  cleared: boolean;
  codeKind: "TOUR15" | "TOUR20" | null;
  skippedReason?: "NO_PENDING" | "NOT_ENTITLEMENT_CODE";
  warnings: string[];
};

export async function revokePendingTourCreditIfNeeded(params: {
  admin: AdminApiContext;
  customerId: string;
  reason: string;
}): Promise<PendingTourCreditRevokeResult> {
  const { admin, customerId, reason } = params;
  const warnings: string[] = [];
  const pending = await getTourPending(customerId);

  if (!pending) {
    return {
      checked: true,
      revoked: false,
      cleared: false,
      codeKind: null,
      skippedReason: "NO_PENDING",
      warnings,
    };
  }

  const kind = getTourCodeKind(pending.code);
  if (kind !== "TOUR15" && kind !== "TOUR20") {
    return {
      checked: true,
      revoked: false,
      cleared: false,
      codeKind: null,
      skippedReason: "NOT_ENTITLEMENT_CODE",
      warnings,
    };
  }

  let revoked = false;
  try {
    await revokeCode(admin, customerId, pending.code, pending.discountId || undefined);
    revoked = true;
  } catch (error) {
    warnings.push(
      `PENDING_TOUR_REVOKE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let cleared = false;
  if (revoked) {
    try {
      await clearTourPending(customerId);
      cleared = true;
    } catch (error) {
      warnings.push(
        `PENDING_TOUR_CLEAR_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      message: "Pending tour credit revoke processed",
      reason,
      customerIdMasked: maskCustomerId(customerId),
      codeMasked: maskCouponCode(pending.code),
      codeKind: kind,
      revoked,
      cleared,
      warnings,
    }),
  );

  return {
    checked: true,
    revoked,
    cleared,
    codeKind: kind,
    warnings,
  };
}
