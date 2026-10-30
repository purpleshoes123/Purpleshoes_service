import type { ActionFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { quoteSchema } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { getPricingEngine } from "~/domains/catalog/pricingEngine";
import { getTierVariantTable } from "~/domains/catalog/tierVariantPricingService";
import { paxTierDiagnostics } from "~/domains/catalog/paxTierDiagnostics";
import { getEnv } from "~/lib/env";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { resolveBookingPolicy } from "~/domains/bookings/bookingConfigResolver";
import { maskPII } from "~/lib/masking";
import { extractCustomerIdFromProxyRequest } from "~/domains/checkout/guideExtension/customerId";
import { getState } from "~/domains/coupons/state";
import { resolveEffectiveTour15Balance } from "~/domains/coupons/effectiveEligibility";
import { resolveActiveExtra10 } from "~/domains/coupons/extra10Availability";
import { fetchCustomerTourCreditBalance } from "~/domains/checkout/tourCredits/metafields";
import {
  getCachedTour15Balance,
  setCachedTour15Balance,
} from "~/domains/coupons/display/tour15BalanceCache";
import { buildMaxDiscountPreview } from "~/domains/coupons/display/discountPreview";
import { resolveBookingProductId } from "~/domains/bookings/bookingContext.server.ts";

/**
 * SSOT 2.1: POST /proxy/bta/quote
 * SSOT 5.2: Quote 입력 스키마 (JSON body)
 * SSOT 7.3: Quote 응답 스키마
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. 레이트 리밋 검증
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // 2. App Proxy 서명 검증
  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) {
    return verifyResponse;
  }

  // 3. correlationId 추출/생성
  const correlationId = respond.getCorrelationId(request);

  try {
    // 4. JSON body 파싱 및 검증
    const body = await request.json();
    const validatedInput = quoteSchema.parse(body);

    // 5. shop 정보 추출 (Phase 5-6)
    const shop = extractShopFromRequest(request);
    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const productId = await resolveBookingProductId(validatedInput.productId, shop);
    if (!productId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        "예약 세션이 만료되었습니다. 페이지를 새로고침해 주세요.",
        undefined,
        400,
        correlationId,
      );
    }

    // 6. Resolver를 통해 정책 결정 (maxPax 검증용)
    const policy = await resolveBookingPolicy(productId, shop, {
      bookingMode: validatedInput.bookingMode,
      poolKey: validatedInput.poolKey,
      guideUnitsRequired: validatedInput.guideUnitsRequired,
    });

    // 7. travelers 정보 추출 (Phase 5-6)
    const travelers = validatedInput.travelers
      ? {
          adult: validatedInput.travelers.adult,
          child: validatedInput.travelers.child,
          infant: validatedInput.travelers.infant,
        }
      : undefined;

    // 8. pax 계산 (travelers가 있으면 합계, 없으면 pax 사용)
    const pax = travelers
      ? travelers.adult + travelers.child + travelers.infant
      : validatedInput.pax || 1;

    // 9. maxPax 검증 (metafield에서 설정된 경우)
    if (policy.maxPax && pax > policy.maxPax) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          `최대 인원수(${policy.maxPax}명)를 초과했습니다.`,
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    // 10. Tier 진단 (운영 설정 오류를 조기에 노출)
    if (getEnv().TIER_ENABLED) {
      const tierTable = await getTierVariantTable({
        productId,
        shop,
      });
      const diagnostics = paxTierDiagnostics({
        travelMaxPax: policy.maxPax ?? pax,
        tierTable,
      });
      if (!diagnostics.ok) {
        const detail = diagnostics.errors.slice(0, 3).join("; ");
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            `상품 설정 오류: ${detail}. Ticket Type × Pax Tier(1..N) variants/price 입력 확인`,
          ),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }
    }

    // 11. Pricing Engine 호출
    const engine = getPricingEngine();
    const quoteDTO = await engine.calculateQuote(
      productId,
      pax,
      validatedInput.currency,
      travelers,
      shop || undefined,
    );

    // 12. discountPreview 계산 (로그인 여부에 따라)
    let discountPreview = null;
    try {
      const customerId = extractCustomerIdFromProxyRequest(request);
      if (!customerId) {
        discountPreview = buildMaxDiscountPreview({
          total: quoteDTO.total,
          creditBalance: 0,
          extra10Available: false,
          isLoggedIn: false,
        });
      } else {
        const state = await getState(customerId);
        const admin = await getAdminApiClient(shop);
        const extra10Availability = await resolveActiveExtra10({
          admin,
          customerId,
          state,
        });
        const extra10Available = extra10Availability.available;

        let creditBalance = await getCachedTour15Balance(customerId);
        let cacheHit = true;
        if (creditBalance === null) {
          cacheHit = false;
          if (admin) {
            creditBalance = await fetchCustomerTourCreditBalance(admin, customerId);
            await setCachedTour15Balance(customerId, creditBalance);
          } else {
            creditBalance = 0;
          }
        }

        const rawCreditBalance = Math.max(0, Math.trunc(creditBalance));
        const effectiveCreditBalance = resolveEffectiveTour15Balance({
          rawCreditBalance,
          state,
        });

        discountPreview = buildMaxDiscountPreview({
          total: quoteDTO.total,
          creditBalance: effectiveCreditBalance,
          extra10Available,
          isLoggedIn: true,
        });

        console.log(
          JSON.stringify({
            message: "Quote discount preview computed",
            customerIdMasked: customerId.slice(-4),
            creditBalance: effectiveCreditBalance,
            extra10Available,
            extra10Reason: extra10Availability.reason || null,
            cacheHit,
            rawCreditBalance,
            entitledTour15: state.entitledTour15,
            tour15AdminBlocked: state.tour15AdminBlocked,
          }),
        );
      }
    } catch (previewError) {
      console.warn(
        JSON.stringify({
          message: "Quote discount preview fallback",
          error: previewError instanceof Error ? previewError.message : String(previewError),
        }),
      );
      discountPreview = buildMaxDiscountPreview({
        total: quoteDTO.total,
        creditBalance: 0,
        extra10Available: false,
        isLoggedIn: false,
      });
    }

    // 13. 응답 반환
    return respond.ok(
      {
        ...quoteDTO,
        discountPreview,
      },
      { correlationId },
    );
  } catch (error) {
    // JSON 파싱 에러
    if (error instanceof SyntaxError) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    // Zod 검증 에러
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    // Pricing Engine 에러
    if (error instanceof Error) {
      // 타임아웃 에러
      if (error.message.includes("timeout") || error.name === "TimeoutError") {
        return respond.fail(
          ErrorCode.BOOKING_STORE_TIMEOUT,
          getErrorMessage(ErrorCode.BOOKING_STORE_TIMEOUT),
          undefined,
          getErrorStatus(ErrorCode.BOOKING_STORE_TIMEOUT),
          correlationId,
        );
      }

      // Phase 5-6: Variant 가격 조회 실패 (세션 없음, Ticket Type 누락 등)
      if (
        error.message.includes("Session not found") ||
        error.message.includes("not found") ||
        error.message.includes("Ticket Type")
      ) {
        // Ticket Type 누락은 VALIDATION_ERROR로 처리
        if (error.message.includes("Ticket Type")) {
          return respond.fail(
            ErrorCode.VALIDATION_ERROR,
            getErrorMessage(
              ErrorCode.VALIDATION_ERROR,
              "상품에 Ticket Type(Adult/Child/Infant) variant가 설정되지 않았습니다.",
            ),
            undefined,
            getErrorStatus(ErrorCode.VALIDATION_ERROR),
            correlationId,
          );
        }

        // 세션 없음은 INTERNAL_ERROR로 처리 (앱 미설치 등)
        return respond.fail(
          ErrorCode.INTERNAL_ERROR,
          getErrorMessage(
            ErrorCode.INTERNAL_ERROR,
            "Shopify Admin API 세션을 찾을 수 없습니다. 앱이 설치되어 있는지 확인하세요.",
          ),
          undefined,
          getErrorStatus(ErrorCode.INTERNAL_ERROR),
          correlationId,
        );
      }

      // 기타 에러
      return respond.fail(
        ErrorCode.BOOKING_STORE_ERROR,
        getErrorMessage(ErrorCode.BOOKING_STORE_ERROR),
        undefined,
        getErrorStatus(ErrorCode.BOOKING_STORE_ERROR),
        correlationId,
      );
    }

    // 기타 에러 (PII 마스킹)
    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Quote 엔드포인트 오류",
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.cause ? { cause: error.cause } : {}),
        }),
      ),
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
