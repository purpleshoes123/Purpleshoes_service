import type { ActionFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { reservationsSchema } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import { checkEligibility, normalizeBookingInput } from "~/domains/bookings/bookingEligibility";
import { maskPII } from "~/lib/masking";
import { resolveBookingProductId } from "~/domains/bookings/bookingContext.server.ts";

/**
 * SSOT 2.1: POST /proxy/bta/reservations
 * SSOT 5.3: Reservations 입력 스키마 (JSON body)
 * SSOT 7.4: Reservations 응답 스키마 (Hold)
 * FR5: idempotency 키 지원 (clientRequestId)
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
    const validatedInput = reservationsSchema.parse(body);
    const reservationDate = validatedInput.date;
    const reservationPax =
      validatedInput.pax ??
      (validatedInput.travelers
        ? validatedInput.travelers.adult +
          validatedInput.travelers.child +
          validatedInput.travelers.infant
        : 0);
    if (!reservationDate || reservationPax < 1) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        "예약 날짜와 인원수가 필요합니다.",
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    // 5. shop 정보 추출 (metafield 조회용)
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

    // 6. 공통 정규화/Eligibility 체크 (hold 생성 직전)
    const normalized = await normalizeBookingInput({
      productId,
      shop,
      date: reservationDate,
      pax: reservationPax,
      option: validatedInput.options ? Object.keys(validatedInput.options)[0] : undefined,
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
            message: "Reservations eligibility",
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
            customer: {
              name: validatedInput.customer?.name
                ? `${validatedInput.customer.name[0]}***`
                : undefined,
              email: validatedInput.customer?.email,
              phone: validatedInput.customer?.phone,
            },
            eligibility: {
              available: eligibility.available,
              remaining: eligibility.remaining,
              reason: eligibility.reason,
              message: eligibility.message,
              details: eligibility.details,
            },
          }),
        ),
      );
    }

    const durable = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
    // Blackouts and absent policy remain hard failures. Capacity/hold reads
    // are advisory: the atomic store both rechecks them and handles a retry
    // of the caller's existing hold before deciding availability.
    const atomicRecheck =
      durable && ["CAPACITY", "ACTIVE_HOLD", "CONFIRMED"].includes(eligibility.reason);
    if (!eligibility.available && !atomicRecheck) {
      return respond.fail(
        ErrorCode.BOOKING_NOT_AVAILABLE,
        getErrorMessage(ErrorCode.BOOKING_NOT_AVAILABLE),
        {
          date: validatedInput.date,
          poolKey: normalized.poolKey,
          bookingMode: normalized.bookingMode,
          guideUnitsRequired: normalized.guideUnitsRequired,
          remaining: eligibility.remaining,
          reason: eligibility.reason,
        },
        getErrorStatus(ErrorCode.BOOKING_NOT_AVAILABLE),
        correlationId,
      );
    }

    // 7. Slot key 생성 (정규화된 키 사용)
    const slotKey = normalized.slotKey;

    // 8. Booking Store 가져오기
    const store = getBookingStore();

    // 9. Idempotency 체크 (clientRequestId가 있는 경우)
    if (!durable && validatedInput.clientRequestId) {
      const existingHold = await store.getHoldByIdempotencyKey(validatedInput.clientRequestId);
      if (existingHold) {
        // 기존 hold 반환
        return respond.ok(existingHold, { correlationId });
      }
    }

    // 10. Hold 생성 (Phase 5-5: 원자적 락 획득 포함)
    const poolDayKey = normalized.poolDayKey;
    const capacityUnits = normalized.policy.poolCapacity ?? 1;

    try {
      const reservationDTO = await store.createHold(
        slotKey,
        reservationPax,
        validatedInput.customer,
        validatedInput.clientRequestId,
        {
          poolDayKey,
          units: normalized.guideUnitsRequired,
          bookingMode: normalized.bookingMode,
          poolKey: normalized.poolKey,
          date: reservationDate,
          capacityUnits,
        },
      );

      // 11. 응답 반환
      return respond.ok(reservationDTO, { correlationId });
    } catch (holdError) {
      // Phase 5-5: 원자적 락 획득 실패 (BOOKING_NOT_AVAILABLE)
      if (holdError instanceof Error && holdError.message === "BOOKING_NOT_AVAILABLE") {
        return respond.fail(
          ErrorCode.BOOKING_NOT_AVAILABLE,
          getErrorMessage(ErrorCode.BOOKING_NOT_AVAILABLE),
          {
            date: validatedInput.date,
            poolKey: validatedInput.poolKey,
          },
          getErrorStatus(ErrorCode.BOOKING_NOT_AVAILABLE),
          correlationId,
        );
      }
      // 다른 에러는 아래 catch 블록에서 처리
      throw holdError;
    }
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

    // Booking Store 에러
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

      // 기타 Booking Store 에러
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
          message: "Reservations 엔드포인트 오류",
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
