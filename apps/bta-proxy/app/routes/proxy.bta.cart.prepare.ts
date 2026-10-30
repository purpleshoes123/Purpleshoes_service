import type { ActionFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { cartPrepareSchema } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { prepareCartItems } from "~/domains/checkout/cartPrepareService";
import { getTierVariantTable } from "~/domains/catalog/tierVariantPricingService";
import { paxTierDiagnostics } from "~/domains/catalog/paxTierDiagnostics";
import { getEnv } from "~/lib/env";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import { resolveBookingPolicy } from "~/domains/bookings/bookingConfigResolver";
import { maskPII } from "~/lib/masking";
import { resolveBookingProductId } from "~/domains/bookings/bookingContext.server.ts";

/**
 * SSOT 2.1: POST /proxy/bta/cart/prepare
 * SSOT 6.5: Cart Prepare 입력 스키마 (JSON body)
 * SSOT 8.6: Cart Prepare 응답 스키마
 * Phase 5-7: travelers 입력을 Shopify Cart 라인아이템으로 변환
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
  let shop: string | null = null;

  try {
    // 4. JSON body 파싱 및 검증
    const body = await request.json();
    const validatedInput = cartPrepareSchema.parse(body);

    // 5. shop 정보 추출
    shop = extractShopFromRequest(request);
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

    // 6. Resolver를 통해 정책 결정
    const policy = await resolveBookingPolicy(productId, shop, {
      bookingMode: validatedInput.bookingMode,
      poolKey: validatedInput.poolKey,
      guideUnitsRequired: validatedInput.guideUnitsRequired,
    });

    // 7. maxPax 검증 (metafield에서 설정된 경우)
    const totalPax =
      validatedInput.travelers.adult +
      validatedInput.travelers.child +
      validatedInput.travelers.infant;
    if (policy.maxPax && totalPax > policy.maxPax) {
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

    // 8. Tier 진단 (운영 설정 오류를 조기에 노출)
    if (getEnv().TIER_ENABLED) {
      const tierTable = await getTierVariantTable({
        productId,
        shop,
      });
      const diagnostics = paxTierDiagnostics({
        travelMaxPax: policy.maxPax ?? totalPax,
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

    // 9. Cart Prepare 서비스 호출 (resolver 결과 반영)
    const result = await prepareCartItems(
      productId,
      validatedInput.date,
      {
        adult: validatedInput.travelers.adult,
        child: validatedInput.travelers.child,
        infant: validatedInput.travelers.infant,
      },
      shop,
      {
        bookingMode: policy.bookingMode,
        poolKey: policy.poolKey,
        guideUnitsRequired: policy.guideUnitsRequired,
        holdId: validatedInput.holdId,
      },
    );

    // 10. 응답 반환
    return respond.ok(result, { correlationId });
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

    // Cart Prepare 서비스 에러
    if (error instanceof Error) {
      if (process.env.DEBUG_BOOKING === "1") {
        console.error(
          JSON.stringify(
            maskPII({
              correlationId,
              message: "Cart prepare failed",
              errorType: error.name,
              errorMessage: error.message,
              shop,
            }),
          ),
        );
      }

      // 세션 없음
      if (
        error.message.includes("Session not found") ||
        error.message.includes("Access token is missing") ||
        error.message.includes("Shop information is required")
      ) {
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

      // Variant 매핑 실패 (Ticket Type/Pax Tier 누락 등)
      if (
        error.message.includes("Ticket Type") ||
        error.message.includes("Pax Tier") ||
        error.message.includes("Tier") ||
        error.message.includes("variant not found") ||
        error.message.includes("Product not found")
      ) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            "상품에 Ticket Type(Adult/Child/Infant) × Pax Tier(1..N) variants/가격이 설정되지 않았습니다. Shopify Admin에서 옵션 2개(Ticket Type, Pax Tier)와 3×N variants 및 가격 입력을 확인하세요.",
          ),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
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
          message: "Cart Prepare 엔드포인트 오류",
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.cause && { cause: error.cause }),
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
