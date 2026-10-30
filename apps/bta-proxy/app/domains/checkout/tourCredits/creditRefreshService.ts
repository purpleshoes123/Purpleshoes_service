import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { acquireLock, releaseLock } from "~/domains/coupons/lock";
import { getCouponRulesConfig } from "~/domains/coupons/config";
import { normalizeCode, normalizeHandles, normalizeTags } from "~/domains/coupons/normalize";
import { normalizeCustomerId } from "~/domains/coupons/normalize";
import { findCustomerReviewByOrder } from "~/domains/reviews/reviewService";
import { getKstTodayDateString, isDateOnOrBefore, normalizeDateOnly } from "./date";
import {
  fetchCustomerTourCreditBalance,
  markOrderTourCreditGranted,
  setCustomerTourCreditBalance,
} from "./metafields";
import { fetchRecentCustomerOrders } from "./orderQueries";
import { withShopifyRetry } from "./shopifyRetry";

type RefreshResult = {
  creditBalance: number;
  newlyGrantedOrderIds: string[];
  warnings: string[];
  locked?: boolean;
};

type LineItemTravelInfo = {
  travelDate: string | null;
  tourMatched: boolean;
};

function extractTravelDate(customAttributes: Array<{ key: string; value: string }>): {
  travelDate: string | null;
  invalid: boolean;
} {
  for (const attr of customAttributes || []) {
    const key = attr?.key?.toLowerCase?.() || "";
    if (key === "travel_date" || key === "traveldate") {
      const normalized = normalizeDateOnly(attr.value);
      return { travelDate: normalized, invalid: normalized === null };
    }
  }
  return { travelDate: null, invalid: false };
}

function detectTourLineItem(
  lineItem: {
    productType?: string | null;
    tags?: string[] | null;
    collections?: string[] | null;
    productId?: string | null;
    variantId?: string | null;
  },
  config = getCouponRulesConfig(),
): boolean {
  const hasCollectionRule = config.tourCollectionHandles.size > 0;
  const hasTagRule = config.tourTags.size > 0;
  const hasTypeRule = config.tourProductTypes.size > 0;

  if (hasCollectionRule) {
    const collections = normalizeHandles(lineItem.collections ?? null);
    for (const handle of collections) {
      if (config.tourCollectionHandles.has(handle)) {
        return true;
      }
    }
    return false;
  }

  if (hasTagRule) {
    const tags = normalizeTags(lineItem.tags ?? null);
    for (const tag of tags) {
      if (config.tourTags.has(tag)) {
        return true;
      }
    }
    return false;
  }

  if (hasTypeRule) {
    const productType = normalizeCode(lineItem.productType ?? null);
    if (productType && config.tourProductTypes.has(productType)) {
      return true;
    }
    return false;
  }

  return false;
}

function computeLineItemTravelInfo(lineItem: {
  customAttributes: Array<{ key: string; value: string }>;
  productType?: string | null;
  tags?: string[] | null;
  collections?: string[] | null;
  productId?: string | null;
  variantId?: string | null;
}): LineItemTravelInfo & { invalidDate: boolean } {
  const { travelDate, invalid } = extractTravelDate(lineItem.customAttributes || []);
  if (!travelDate) {
    return { travelDate: null, tourMatched: false, invalidDate: invalid };
  }

  return {
    travelDate,
    tourMatched: detectTourLineItem(lineItem),
    invalidDate: invalid,
  };
}

export async function refreshCreditsForCustomer(params: {
  admin: AdminApiContext;
  shop: string;
  customerId: string;
  limit?: number;
}): Promise<RefreshResult> {
  const { admin, shop, customerId } = params;
  const limit = params.limit ?? 50;
  const warnings: string[] = [];

  const lockCustomerId = normalizeCustomerId(customerId) || customerId;
  const locked = await acquireLock("tourCreditRefresh", lockCustomerId, 30);
  if (!locked) {
    return {
      creditBalance: 0,
      newlyGrantedOrderIds: [],
      warnings: ["LOCKED"],
      locked: true,
    };
  }

  try {
    const todayKst = getKstTodayDateString();
    const currentBalance = await fetchCustomerTourCreditBalance(admin, customerId);
    const orders = await fetchRecentCustomerOrders(admin, customerId, limit);

    const eligibleOrders: Array<{ orderId: string }> = [];

    for (const order of orders) {
      if (!order?.id) {
        continue;
      }
      if (order.tourCreditGranted) {
        continue;
      }

      const status = (order.displayFinancialStatus || "").toUpperCase();
      if (status !== "PAID") {
        continue;
      }

      const travelCandidates = order.lineItems.map((lineItem) =>
        computeLineItemTravelInfo(lineItem),
      );

      for (const info of travelCandidates) {
        if (info.invalidDate) {
          warnings.push(`TRAVEL_DATE_INVALID:${order.id}`);
          break;
        }
      }

      const validTravelCandidates = travelCandidates.filter((info) => Boolean(info.travelDate));

      if (validTravelCandidates.length === 0) {
        continue;
      }

      const hasReached = validTravelCandidates.some(
        (info) => info.travelDate && isDateOnOrBefore(info.travelDate, todayKst),
      );
      if (!hasReached) {
        continue;
      }

      const hasTourMatch = validTravelCandidates.some((info) => info.tourMatched);
      if (!hasTourMatch) {
        warnings.push(`TOUR_PRODUCT_NOT_MATCHED:${order.id}`);
        continue;
      }

      let reviewExists = false;
      try {
        const review = await withShopifyRetry(async () => {
          try {
            return await findCustomerReviewByOrder({
              shop,
              orderId: order.id,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
              message.includes("429") ||
              message.toLowerCase().includes("thrott") ||
              message.toLowerCase().includes("rate")
            ) {
              const retryable = new Error(message);
              (retryable as any).retryable = true;
              throw retryable;
            }
            throw error;
          }
        });
        reviewExists = Boolean(review);
      } catch (error) {
        warnings.push(
          `REVIEW_LOOKUP_FAILED:${order.id}:${error instanceof Error ? error.message : String(error)}`,
        );
        reviewExists = false;
      }

      if (!reviewExists) {
        continue;
      }

      eligibleOrders.push({ orderId: order.id });
    }

    const markedOrderIds: string[] = [];
    for (const entry of eligibleOrders) {
      try {
        await markOrderTourCreditGranted(admin, entry.orderId);
        markedOrderIds.push(entry.orderId);
      } catch (error) {
        warnings.push(
          `ORDER_GRANT_FAILED:${entry.orderId}:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    let finalBalance = currentBalance;
    if (markedOrderIds.length > 0) {
      const nextBalance = currentBalance + markedOrderIds.length;
      try {
        await setCustomerTourCreditBalance(admin, customerId, nextBalance);
        finalBalance = nextBalance;
      } catch (error) {
        warnings.push(
          `BALANCE_UPDATE_FAILED:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(
      JSON.stringify({
        message: "Tour credit refresh completed",
        customerId: lockCustomerId,
        scannedCount: orders.length,
        eligibleCount: eligibleOrders.length,
        grantedCount: markedOrderIds.length,
        balanceBefore: currentBalance,
        balanceAfter: finalBalance,
        warningsCount: warnings.length,
      }),
    );

    return {
      creditBalance: finalBalance,
      newlyGrantedOrderIds: markedOrderIds,
      warnings,
    };
  } finally {
    await releaseLock("tourCreditRefresh", lockCustomerId);
  }
}
