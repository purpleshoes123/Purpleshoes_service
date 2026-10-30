import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  isGuideBundleTour15SourceRevoked,
  restoreConsumedTour15Source,
  type Tour15ConsumedSourceType,
} from "~/domains/coupons/tour15Sources";
import { tryMarkEventOnce } from "~/domains/coupons/idempotency";
import { getTourCodeKind } from "~/domains/coupons/policy/codes";
import { normalizeCustomerId } from "~/domains/coupons/normalize";
import { maskCouponCode, maskCustomerId } from "~/domains/coupons/logging";
import { clearCachedTour15Balance } from "~/domains/coupons/display/tour15BalanceCache";
import { clearTourPending } from "~/domains/checkout/tourCheckout/pending";
import { fetchOrderCustomerId } from "~/domains/checkout/guideExtension/orderCustomer";
import {
  fetchCustomerTourCreditBalance,
  fetchOrderTourCreditConsumedSnapshot,
  markOrderTourCreditRestored,
  setCustomerTourCreditBalance,
} from "./metafields";
import { fetchOrderDiscountCodes } from "./orderQueries";

export type RestoreTourCreditResult = {
  restored: boolean;
  reason?:
    | "NO_TOUR_CODE"
    | "NOT_CONSUMED"
    | "ALREADY_RESTORED"
    | "DUPLICATE"
    | "MISSING_CUSTOMER"
    | "SOURCE_REVOKED"
    | "UNKNOWN_SOURCE"
    | "BALANCE_UPDATE_FAILED"
    | "SOURCE_RESTORE_FAILED"
    | "RESTORE_MARK_FAILED";
  code?: string | null;
  balanceBefore?: number;
  balanceAfter?: number;
  warnings: string[];
};

function sourceTypeFromSnapshot(value: Tour15ConsumedSourceType | null): Tour15ConsumedSourceType {
  return value || "LEGACY";
}

export async function restoreTourCreditForOrder(params: {
  admin: AdminApiContext;
  shop: string;
  orderId: string;
  customerId?: string | null;
  refundId?: string | null;
  reason: string;
}): Promise<RestoreTourCreditResult> {
  const { admin, orderId, refundId } = params;
  const warnings: string[] = [];
  const codes = await fetchOrderDiscountCodes(admin, orderId);
  const tourCode = codes.find((code) => {
    const kind = getTourCodeKind(code);
    return kind === "TOUR15" || kind === "TOUR20";
  });

  console.log(
    JSON.stringify({
      message: "Tour credit restore check",
      orderId,
      refundId: refundId || null,
      reason: params.reason,
      codesMasked: codes.map(maskCouponCode),
      tourCodeMasked: maskCouponCode(tourCode),
    }),
  );

  if (!tourCode) {
    return { restored: false, reason: "NO_TOUR_CODE", warnings };
  }

  const snapshot = await fetchOrderTourCreditConsumedSnapshot(admin, orderId);
  if (snapshot.restored) {
    console.log(
      JSON.stringify({
        message: "Tour credit restore skipped",
        reason: "ALREADY_RESTORED",
        orderId,
        refundId: refundId || null,
        codeMasked: maskCouponCode(tourCode),
      }),
    );
    return { restored: false, reason: "ALREADY_RESTORED", code: tourCode, warnings };
  }
  if (!snapshot.consumed) {
    return { restored: false, reason: "NOT_CONSUMED", code: tourCode, warnings };
  }

  const marked = await tryMarkEventOnce("tour_credit_restore", orderId, 180 * 24 * 60 * 60);
  if (!marked) {
    return { restored: false, reason: "DUPLICATE", code: tourCode, warnings };
  }

  let customerId = params.customerId || null;
  if (!customerId) {
    try {
      customerId = await fetchOrderCustomerId(admin, orderId);
    } catch (error) {
      warnings.push(
        `CUSTOMER_LOOKUP_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!customerId) {
    return { restored: false, reason: "MISSING_CUSTOMER", code: tourCode, warnings };
  }

  const normalizedCustomerKey = normalizeCustomerId(customerId) || customerId;
  const sourceType = sourceTypeFromSnapshot(snapshot.sourceType);
  const sourceOrderId = snapshot.sourceOrderId || null;

  console.log(
    JSON.stringify({
      message: "Tour credit restore source checked",
      orderId,
      refundId: refundId || null,
      customerIdMasked: maskCustomerId(normalizedCustomerKey),
      codeMasked: maskCouponCode(tourCode),
      sourceType,
      sourceOrderId,
    }),
  );

  if (sourceType === "GUIDE_BUNDLE") {
    const sourceRevoked = await isGuideBundleTour15SourceRevoked(
      normalizedCustomerKey,
      sourceOrderId,
    );
    if (sourceRevoked) {
      console.warn(
        JSON.stringify({
          message: "Tour credit restore skipped",
          reason: "SOURCE_REVOKED",
          orderId,
          refundId: refundId || null,
          customerIdMasked: maskCustomerId(normalizedCustomerKey),
          sourceType,
          sourceOrderId,
        }),
      );
      return { restored: false, reason: "SOURCE_REVOKED", code: tourCode, warnings };
    }
  }

  if (sourceType === "UNKNOWN") {
    warnings.push("UNKNOWN_SOURCE");
    return { restored: false, reason: "UNKNOWN_SOURCE", code: tourCode, warnings };
  }

  const balanceBefore = await fetchCustomerTourCreditBalance(admin, customerId);
  const balanceAfter = balanceBefore + 1;
  try {
    await setCustomerTourCreditBalance(admin, customerId, balanceAfter);
  } catch (error) {
    warnings.push(
      `BALANCE_UPDATE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      restored: false,
      reason: "BALANCE_UPDATE_FAILED",
      code: tourCode,
      balanceBefore,
      warnings,
    };
  }

  try {
    await restoreConsumedTour15Source({
      customerId: normalizedCustomerKey,
      sourceType,
      sourceOrderId,
    });
  } catch (error) {
    warnings.push(
      `SOURCE_RESTORE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      restored: false,
      reason: "SOURCE_RESTORE_FAILED",
      code: tourCode,
      balanceBefore,
      balanceAfter,
      warnings,
    };
  }

  try {
    await markOrderTourCreditRestored(admin, orderId);
  } catch (error) {
    warnings.push(`RESTORE_MARK_FAILED:${error instanceof Error ? error.message : String(error)}`);
    return {
      restored: false,
      reason: "RESTORE_MARK_FAILED",
      code: tourCode,
      balanceBefore,
      balanceAfter,
      warnings,
    };
  }

  try {
    await clearTourPending(customerId);
  } catch (error) {
    warnings.push(`PENDING_CLEAR_FAILED:${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await clearCachedTour15Balance(customerId);
  } catch (error) {
    warnings.push(
      `CACHE_INVALIDATE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(
    JSON.stringify({
      message: "Tour credit restore completed",
      orderId,
      refundId: refundId || null,
      customerIdMasked: maskCustomerId(normalizedCustomerKey),
      codeMasked: maskCouponCode(tourCode),
      codeKind: getTourCodeKind(tourCode),
      sourceType,
      sourceOrderId,
      balanceBefore,
      balanceAfter,
      warnings,
    }),
  );

  return {
    restored: true,
    code: tourCode,
    balanceBefore,
    balanceAfter,
    warnings,
  };
}
