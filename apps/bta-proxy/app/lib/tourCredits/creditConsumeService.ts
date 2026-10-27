import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  consumeOneTour15Source,
  type Tour15ConsumedSourceType,
} from "~/lib/coupons/tour15Sources";
import { tryMarkEventOnce } from "~/lib/coupons/idempotency";
import { getTourCodeKind } from "~/lib/coupons/policy/codes";
import { normalizeCustomerId } from "~/lib/coupons/normalize";
import { maskCouponCode, maskCustomerId } from "~/lib/coupons/logging";
import { fetchOrderCustomerId } from "~/lib/guideExtension/orderCustomer";
import {
  fetchCustomerTourCreditBalance,
  markOrderTourCreditConsumed,
  setCustomerTourCreditBalance,
} from "./metafields";
import { fetchOrderDiscountsWithConsumeFlag } from "./orderQueries";
import { clearTourPending } from "~/lib/tourCheckout/pending";
import { clearCachedTour15Balance } from "~/lib/couponDisplay/tour15BalanceCache";

export type ConsumeResult = {
  consumed: boolean;
  code?: string;
  balanceBefore?: number;
  balanceAfter?: number;
  warnings: string[];
};

function extractDiscountCodesFromPayload(payload: any): string[] {
  const raw = payload?.discount_codes;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => entry?.code)
    .filter((code) => typeof code === "string" && code.trim().length > 0);
}

function resolveConsumedSource(params: {
  balanceBefore: number;
  sourceConsumeResult: Awaited<ReturnType<typeof consumeOneTour15Source>> | null;
}): { sourceType: Tour15ConsumedSourceType; sourceOrderId: string | null } {
  const { balanceBefore, sourceConsumeResult } = params;
  if (sourceConsumeResult?.consumedGuideBundleOrderId) {
    return {
      sourceType: "GUIDE_BUNDLE",
      sourceOrderId: sourceConsumeResult.consumedGuideBundleOrderId,
    };
  }
  if (sourceConsumeResult?.consumedTourReviewSource) {
    return { sourceType: "TOUR_REVIEW", sourceOrderId: null };
  }
  if (balanceBefore > 0) {
    return { sourceType: "LEGACY", sourceOrderId: null };
  }
  return { sourceType: "UNKNOWN", sourceOrderId: null };
}

export async function consumeTourCreditIfApplicable(params: {
  admin: AdminApiContext;
  shop: string;
  orderId: string;
  payload: any;
}): Promise<ConsumeResult> {
  const { admin, orderId, payload } = params;
  const warnings: string[] = [];

  const payloadCodes = extractDiscountCodesFromPayload(payload);
  const fetched = await fetchOrderDiscountsWithConsumeFlag(admin, orderId);
  const codes = payloadCodes.length > 0 ? payloadCodes : fetched.codes;
  const consumed = fetched.consumed;

  console.log(
    JSON.stringify({
      message: "Tour credit consume check",
      orderId,
      customerIdMasked: maskCustomerId(payload?.customer?.id?.toString() || null),
      payloadCodesCount: payloadCodes.length,
      fetchedCodesCount: fetched.codes.length,
      codesMasked: codes.map(maskCouponCode),
      consumedFlag: consumed,
    })
  );

  if (consumed) {
    console.log(
      JSON.stringify({
        message: "Tour credit consume skipped",
        reason: "ALREADY_CONSUMED",
        orderId,
      })
    );
    return { consumed: false, warnings: ["ALREADY_CONSUMED"] };
  }

  const tourCode = codes.find((code) => {
    const kind = getTourCodeKind(code);
    return kind === "TOUR15" || kind === "TOUR20";
  });

  if (!tourCode) {
    console.log(
      JSON.stringify({
        message: "Tour credit consume skipped",
        reason: "NO_TOUR15_OR_TOUR20_CODE",
        orderId,
        codesMasked: codes.map(maskCouponCode),
      })
    );
    return { consumed: false, warnings };
  }

  const marked = await tryMarkEventOnce(
    "tour_credit_consume",
    orderId,
    180 * 24 * 60 * 60
  );
  if (!marked) {
    console.log(
      JSON.stringify({
        message: "Tour credit consume skipped",
        reason: "DUPLICATE",
        orderId,
        codeMasked: maskCouponCode(tourCode),
      })
    );
    return { consumed: false, warnings: ["DUPLICATE"] };
  }

  const payloadCustomerId = payload?.customer?.id?.toString() || null;
  let customerId = payloadCustomerId
    ? `gid://shopify/Customer/${payloadCustomerId}`
    : null;
  if (!customerId) {
    try {
      customerId = await fetchOrderCustomerId(admin, orderId);
    } catch (error) {
      warnings.push(
        `CUSTOMER_LOOKUP_FAILED:${error instanceof Error ? error.message : String(error)}`
      );
      return { consumed: false, warnings };
    }
  }

  if (!customerId) {
    console.warn(
      JSON.stringify({
        message: "Tour credit consume skipped",
        reason: "MISSING_CUSTOMER",
        orderId,
        codeMasked: maskCouponCode(tourCode),
      })
    );
    return { consumed: false, warnings: ["MISSING_CUSTOMER"] };
  }

  const normalizedCustomerKey = normalizeCustomerId(customerId) || customerId;
  const balanceBefore = await fetchCustomerTourCreditBalance(admin, customerId);
  const balanceAfter = Math.max(0, balanceBefore - 1);

  try {
    await setCustomerTourCreditBalance(admin, customerId, balanceAfter);
  } catch (error) {
    warnings.push(
      `BALANCE_UPDATE_FAILED:${error instanceof Error ? error.message : String(error)}`
    );
    return { consumed: false, warnings };
  }

  let entitledTour15Cleared = false;
  let sourceConsumeResult: Awaited<ReturnType<typeof consumeOneTour15Source>> | null = null;
  try {
    sourceConsumeResult = await consumeOneTour15Source(normalizedCustomerKey);
    entitledTour15Cleared = !sourceConsumeResult.entitledTour15After;
  } catch (error) {
    warnings.push(
      `ENTITLED_TOUR15_CLEAR_FAILED:${error instanceof Error ? error.message : String(error)}`
    );
  }

  let orderConsumeMarked = false;
  const consumedAt = Math.floor(Date.now() / 1000);
  const consumedSource = resolveConsumedSource({
    balanceBefore,
    sourceConsumeResult,
  });
  try {
    await markOrderTourCreditConsumed(admin, orderId, {
      code: tourCode,
      kind: getTourCodeKind(tourCode) === "TOUR20" ? "TOUR20" : "TOUR15",
      sourceType: consumedSource.sourceType,
      sourceOrderId: consumedSource.sourceOrderId,
      consumedAt,
    });
    orderConsumeMarked = true;
  } catch (error) {
    warnings.push(
      `ORDER_CONSUME_MARK_FAILED:${error instanceof Error ? error.message : String(error)}`
    );
  }

  let pendingCleared = false;
  try {
    await clearTourPending(customerId);
    pendingCleared = true;
  } catch (error) {
    warnings.push(
      `PENDING_CLEAR_FAILED:${error instanceof Error ? error.message : String(error)}`
    );
  }

  let cacheInvalidated = false;
  try {
    await clearCachedTour15Balance(customerId);
    cacheInvalidated = true;
  } catch (error) {
    warnings.push(
      `CACHE_INVALIDATE_FAILED:${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log(
    JSON.stringify({
      message: "Tour credit consumed",
      orderId,
      customerIdMasked: maskCustomerId(normalizedCustomerKey),
      codeMasked: maskCouponCode(tourCode),
      codeKind: getTourCodeKind(tourCode),
      balanceBefore,
      balanceAfter,
      entitledTour15Cleared,
      consumedGuideBundleOrderId: sourceConsumeResult?.consumedGuideBundleOrderId || null,
      consumedTourReviewSource: sourceConsumeResult?.consumedTourReviewSource || false,
      consumedSourceType: consumedSource.sourceType,
      consumedSourceOrderId: consumedSource.sourceOrderId,
      entitledTour15After: sourceConsumeResult?.entitledTour15After ?? null,
      orderConsumeMarked,
      pendingCleared,
      cacheInvalidated,
      warnings,
    })
  );

  return {
    consumed: true,
    code: tourCode,
    balanceBefore,
    balanceAfter,
    warnings,
  };
}
