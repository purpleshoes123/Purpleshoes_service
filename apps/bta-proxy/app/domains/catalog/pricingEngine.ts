/**
 * Pricing Engine
 * SSOT 7.3: Quote 응답 스키마
 * Phase 5-6: Shopify Variant 가격 기반 계산 지원
 */

import { getTierVariantTable } from "./tierVariantPricingService";
import { getEnv } from "../../lib/env";

/**
 * Quote 결과
 */
export interface QuoteResult {
  currency: string;
  total: number;
  breakdown: Array<{ label: string; amount: number }>;
}

/**
 * Travelers 정보
 */
export interface Travelers {
  adult: number;
  child: number;
  infant: number;
}

/**
 * Pricing Engine 인터페이스
 * Phase 5-6: travelers 및 shop 파라미터 추가
 */
export interface PricingEngine {
  calculateQuote(
    productId: string,
    pax: number,
    currency?: string,
    travelers?: Travelers,
    shop?: string,
  ): Promise<QuoteResult>;
}

/**
 * Pricing Rules 타입
 */
interface PricingRules {
  [productId: string]: {
    basePrice: number;
    serviceFee: number;
  };
}

/**
 * Pricing Engine 구현
 * Phase 5-6: Variant 가격 기반 계산 지원
 */
class PricingEngineImpl implements PricingEngine {
  /**
   * PRICING_RULES_JSON에서 productId별 가격 규칙을 가져옵니다.
   */
  private getPricingRules(): PricingRules | null {
    const rulesJson = process.env.PRICING_RULES_JSON;
    if (!rulesJson) {
      return null;
    }

    try {
      return JSON.parse(rulesJson) as PricingRules;
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Failed to parse PRICING_RULES_JSON",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  /**
   * Base price를 가져옵니다 (레거시 fallback용).
   * 우선순위:
   * 1. PRICING_RULES_JSON의 productId별 basePrice
   * 2. BASE_PRICE_DEFAULT env
   * 3. 하드코딩된 기본값: 90000 KRW
   */
  private getBasePrice(productId: string): number {
    const rules = this.getPricingRules();
    if (rules && rules[productId] && rules[productId].basePrice) {
      return rules[productId].basePrice;
    }

    const defaultBasePrice = Number(process.env.BASE_PRICE_DEFAULT);
    if (defaultBasePrice && defaultBasePrice > 0) {
      return defaultBasePrice;
    }

    // 하드코딩된 기본값
    return 90000;
  }

  /**
   * Variant 가격을 조회합니다 (캐시 우선).
   * Phase 5-6: Shopify Admin API를 통해 variant 가격 조회
   */
  private async getVariantPrices(
    productId: string,
    shop: string | undefined,
  ): Promise<{ adultPrice: number; childPrice: number; infantPrice: number } | null> {
    if (!shop) {
      return null;
    }

    try {
      // 캐시에서 조회
      const { getCachedVariantPrices, setCachedVariantPrices } =
        await import("./variantPricingCache");
      const { getVariantPrices } = await import("./variantPricingService");

      const cached = await getCachedVariantPrices(productId);
      if (cached) {
        return cached;
      }

      // 캐시 미스 시 API 호출
      const prices = await getVariantPrices(productId, shop);
      await setCachedVariantPrices(productId, prices);

      return prices;
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Failed to get variant prices, falling back to env-based pricing",
          productId: productId.substring(0, 20) + "...",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }
  }

  async calculateQuote(
    productId: string,
    pax: number,
    currency: string = "KRW",
    travelers?: Travelers,
    shop?: string,
  ): Promise<QuoteResult> {
    // travelers가 있으면 사용, 없으면 adult = pax로 간주
    const adult = travelers?.adult ?? pax;
    const child = travelers?.child ?? 0;
    const infant = travelers?.infant ?? 0;
    const totalPax = adult + child + infant;
    if (travelers && pax !== totalPax) {
      throw new Error("travelers와 pax가 일치하지 않습니다.");
    }

    // Tier variant 기반 계산 (travelers 우선, 없으면 pax 사용)
    if (shop && getEnv().TIER_ENABLED) {
      let table;
      try {
        table = await getTierVariantTable({ productId, shop });
      } catch {
        table = null;
      }

      if (table) {
        const tierRow = table.byTier[totalPax];
        if (!tierRow?.Adult) {
          throw new Error(`Pax Tier ${totalPax}의 Adult variant가 없음`);
        }
        if (!tierRow.Child) {
          throw new Error(`Pax Tier ${totalPax}의 Child variant가 없음`);
        }
        if (!tierRow.Infant) {
          throw new Error(`Pax Tier ${totalPax}의 Infant variant가 없음`);
        }

        const adultAmount = tierRow.Adult.unitPrice * adult;
        const childAmount = tierRow.Child.unitPrice * child;
        const infantAmount = tierRow.Infant.unitPrice * infant;
        const subtotal = adultAmount + childAmount + infantAmount;

        const breakdown: Array<{ label: string; amount: number }> = [];
        if (adult > 0) {
          breakdown.push({
            label: `Adult x${adult}`,
            amount: adultAmount,
          });
        }
        if (child > 0) {
          breakdown.push({
            label: `Child x${child}`,
            amount: childAmount,
          });
        }
        if (infant > 0) {
          breakdown.push({
            label: `Infant x${infant}`,
            amount: infantAmount,
          });
        }

        return {
          currency,
          total: subtotal,
          breakdown,
        };
      }
    }

    // Variant 가격 조회 시도
    const variantPrices = await this.getVariantPrices(productId, shop);

    let adultPrice: number;
    let childPrice: number;
    let infantPrice: number;

    if (variantPrices) {
      // Variant 가격 사용
      adultPrice = variantPrices.adultPrice;
      childPrice = variantPrices.childPrice;
      infantPrice = variantPrices.infantPrice;
    } else {
      // Fallback: 기존 env 기반 가격
      const basePrice = this.getBasePrice(productId);
      adultPrice = basePrice;
      childPrice = basePrice; // 기본값: child도 adult와 동일
      infantPrice = 0; // 기본값: infant는 무료
    }

    // 총액 계산
    const adultAmount = adultPrice * adult;
    const childAmount = childPrice * child;
    const infantAmount = infantPrice * infant;
    const subtotal = adultAmount + childAmount + infantAmount;

    // 정합성(quote=checkout=order) 보장을 위해 serviceFee/tax 미사용
    const serviceFee = 0;
    const total = subtotal;

    // Breakdown 생성
    const breakdown: Array<{ label: string; amount: number }> = [];

    if (adult > 0) {
      breakdown.push({
        label: `Adult x${adult}`,
        amount: adultAmount,
      });
    }

    if (child > 0) {
      breakdown.push({
        label: `Child x${child}`,
        amount: childAmount,
      });
    }

    if (infant > 0) {
      breakdown.push({
        label: `Infant x${infant}`,
        amount: infantAmount,
      });
    }

    breakdown.push({
      label: "Service fee",
      amount: serviceFee,
    });

    return {
      currency,
      total,
      breakdown,
    };
  }
}

/**
 * Pricing Engine 인스턴스
 */
let pricingEngineInstance: PricingEngine | null = null;

/**
 * Pricing Engine 인스턴스를 가져옵니다.
 */
export function getPricingEngine(): PricingEngine {
  if (pricingEngineInstance) {
    return pricingEngineInstance;
  }

  pricingEngineInstance = new PricingEngineImpl();
  return pricingEngineInstance;
}
