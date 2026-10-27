/**
 * Cart Prepare 서비스
 * Phase 5-7: travelers 입력을 Shopify Cart 라인아이템으로 변환
 */

import { getTierVariantTable } from "./tierVariantPricingService";
import { getVariantPrices } from "./variantPricingService";
import { getEnv } from "./env";
import type { Travelers } from "./pricingEngine";

/**
 * Cart Item
 */
export interface CartItem {
  variantId: string;
  quantity: number;
}

/**
 * Cart Prepare 결과
 */
export interface CartPrepareResult {
  items: Array<CartItem>;
  properties: Record<string, string>;
}

/**
 * Cart Prepare 옵션
 */
export interface CartPrepareOptions {
  bookingMode?: "private" | "shared";
  poolKey?: string;
  guideUnitsRequired?: number;
  holdId?: string;
}

/**
 * Cart Prepare 서비스
 * travelers 입력을 variantId/quantity 배열과 properties로 변환
 */
export async function prepareCartItems(
  productId: string,
  date: string,
  travelers: Travelers,
  shop: string | null,
  options: CartPrepareOptions = {}
): Promise<CartPrepareResult> {
  if (!shop) {
    throw new Error("Shop information is required for variant price lookup");
  }

  const totalPax = travelers.adult + travelers.child + travelers.infant;
  if (travelers.adult < 1) {
    throw new Error("Adult count must be >= 1");
  }
  if (totalPax < 1) {
    throw new Error("totalPax must be >= 1");
  }

  const items: Array<CartItem> = [];
  if (getEnv().TIER_ENABLED) {
    const tierRow = (await getTierVariantTable({ productId, shop })).byTier[totalPax];
    if (!tierRow?.Adult?.variantId) {
      throw new Error(
        `Pax Tier ${totalPax}의 Adult variant가 없습니다. Shopify Admin에서 (Ticket Type × Pax Tier) variants와 가격을 입력하세요.`
      );
    }
    if (!tierRow.Child?.variantId) {
      throw new Error(
        `Pax Tier ${totalPax}의 Child variant가 없습니다. Shopify Admin에서 (Ticket Type × Pax Tier) variants와 가격을 입력하세요.`
      );
    }
    if (!tierRow.Infant?.variantId) {
      throw new Error(
        `Pax Tier ${totalPax}의 Infant variant가 없습니다. Shopify Admin에서 (Ticket Type × Pax Tier) variants와 가격을 입력하세요.`
      );
    }

    // Items 생성 (quantity > 0인 타입만 포함)
    if (travelers.adult > 0) {
      items.push({
        variantId: tierRow.Adult.variantId,
        quantity: travelers.adult,
      });
    }

    if (travelers.child > 0) {
      items.push({
        variantId: tierRow.Child.variantId,
        quantity: travelers.child,
      });
    }

    if (travelers.infant > 0) {
      items.push({
        variantId: tierRow.Infant.variantId,
        quantity: travelers.infant,
      });
    }
  } else {
    const legacy = await getVariantPrices(productId, shop);
    if (travelers.adult > 0) {
      items.push({
        variantId: legacy.variantIds.adult as string,
        quantity: travelers.adult,
      });
    }
    if (travelers.child > 0) {
      if (!legacy.variantIds.child) {
        throw new Error(`Ticket Type "Child" variant not found for product ${productId}`);
      }
      items.push({
        variantId: legacy.variantIds.child,
        quantity: travelers.child,
      });
    }
    if (travelers.infant > 0) {
      if (!legacy.variantIds.infant) {
        throw new Error(`Ticket Type "Infant" variant not found for product ${productId}`);
      }
      items.push({
        variantId: legacy.variantIds.infant,
        quantity: travelers.infant,
      });
    }
  }

  // Properties 생성 (표준 키 사용)
  const properties: Record<string, string> = {
    travel_date: date,
    booking_mode: options.bookingMode || "private",
    pool_key: options.poolKey || "DEFAULT",
    guide_units_required: String(options.guideUnitsRequired || 1),
    total_pax: String(totalPax),
  };

  if (getEnv().TIER_ENABLED) {
    properties.pricing_tier_pax = String(totalPax);
    properties.pricing_version = "TIERED_PAX_V1";
  }

  // holdId가 있으면 추가
  if (options.holdId) {
    properties.hold_id = options.holdId;
  }

  // travelers_json (디버깅용, PII 없음)
  properties.travelers_json = JSON.stringify({
    adult: travelers.adult,
    child: travelers.child,
    infant: travelers.infant,
  });

  return {
    items,
    properties,
  };
}
