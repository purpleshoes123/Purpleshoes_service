import type { LoaderFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import {
  availabilitySchema,
  parseQueryParams,
  type AvailabilityInput,
} from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { checkEligibility, normalizeBookingInput } from "~/lib/bookingEligibility";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import { maskPII } from "~/lib/masking";
import { resolveBookingProductId } from "~/lib/bookingContext.server";

/**
 * SSOT 2.1: GET /proxy/bta/availability
 * SSOT 5.1: Availability 입력 스키마 (Query)
 * SSOT 7.2: Availability 응답 스키마
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 레이트 리밋 검증
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  // 2. App Proxy 서명 검증
  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  // 3. correlationId 추출/생성
  const correlationId = respond.getCorrelationId(request);
  let validatedInput: AvailabilityInput | null = null;
  let shop: string | null = null;

  try {
    // 4. 쿼리 파라미터 파싱 및 검증
    const url = new URL(request.url);
    const queryParams = parseQueryParams(url);
    validatedInput = availabilitySchema.parse(queryParams);

    // 5. shop 정보 추출 (metafield 조회용)
    shop = extractShopFromRequest(request);
    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const productId = await resolveBookingProductId(validatedInput.productId, shop);
    if (!productId) {
      return respond.fail(ErrorCode.VALIDATION_ERROR, "예약 세션이 만료되었습니다. 페이지를 새로고침해 주세요.", undefined, 400, correlationId);
    }

    // 6. 공통 정규화/Eligibility 체크
    const normalized = await normalizeBookingInput({
      productId,
      shop,
      date: validatedInput.date,
      pax: validatedInput.pax,
      option: validatedInput.option,
      time: validatedInput.time,
      bookingMode: validatedInput.bookingMode,
      poolKey: validatedInput.poolKey,
      guideUnitsRequired: validatedInput.guideUnitsRequired,
    });
    const eligibility = await checkEligibility(normalized);

    if (process.env.DEBUG_BOOKING === "1") {
      console.log(
        JSON.stringify(
          maskPII({
            correlationId,
            message: "Availability eligibility",
            normalized: {
              productId: normalized.productId,
              shop: normalized.shop,
              date: normalized.date,
              pax: normalized.pax,
              bookingMode: normalized.bookingMode,
              poolKey: normalized.poolKey,
              guideUnitsRequired: normalized.guideUnitsRequired,
              slotKey: normalized.slotKey,
              legacySlotKey: normalized.legacySlotKey,
              poolDayKey: normalized.poolDayKey,
            },
            eligibility: {
              available: eligibility.available,
              remaining: eligibility.remaining,
              reason: eligibility.reason,
              message: eligibility.message,
              details: eligibility.details,
            },
          })
        )
      );
    }

    const availabilityDTO = {
      available: eligibility.available,
      remaining: eligibility.remaining,
      cutoffMinutes: 30,
      message: eligibility.message,
    };

    // 7. 응답 반환
    return respond.ok(availabilityDTO, { correlationId });
  } catch (error) {
    // Zod 검증 에러
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues
        .map((issue) => issue.message)
        .join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    // Booking Store 에러
    if (error instanceof Error) {
      console.error(
        JSON.stringify(
          maskPII({
            correlationId,
            message: "Availability 처리 실패",
            errorType: error.name,
            errorMessage: error.message,
            productId: validatedInput?.productId,
            shop,
            date: validatedInput?.date,
            pax: validatedInput?.pax,
            bookingMode: validatedInput?.bookingMode,
            poolKey: validatedInput?.poolKey,
            ...(error.cause instanceof Error
              ? { cause: error.cause.message }
              : error.cause
                ? { cause: error.cause }
                : {}),
          })
        )
      );

      // 타임아웃 에러
      if (
        error.message.includes("timeout") ||
        error.name === "TimeoutError"
      ) {
        return respond.fail(
          ErrorCode.BOOKING_STORE_TIMEOUT,
          getErrorMessage(ErrorCode.BOOKING_STORE_TIMEOUT),
          undefined,
          getErrorStatus(ErrorCode.BOOKING_STORE_TIMEOUT),
          correlationId
        );
      }

      // 기타 Booking Store 에러
      return respond.fail(
        ErrorCode.BOOKING_STORE_ERROR,
        getErrorMessage(ErrorCode.BOOKING_STORE_ERROR),
        undefined,
        getErrorStatus(ErrorCode.BOOKING_STORE_ERROR),
        correlationId
      );
    }

    // 기타 에러 (PII 마스킹)
    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Availability 엔드포인트 오류",
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.cause && { cause: error.cause }),
        })
      )
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
