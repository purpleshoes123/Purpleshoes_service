import type { LoaderFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { disabledDatesSchema, parseQueryParams, type DisabledDatesInput } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { checkAvailability } from "~/domains/bookings/availabilityService";
import { extractShopFromRequest, listGlobalBlackouts } from "~/lib/shopifyAdmin";
import { getDateRange } from "~/lib/dateUtils";
import { maskPII } from "~/lib/masking";
import { resolveBookingPolicy } from "~/domains/bookings/bookingConfigResolver";
import { resolveBookingProductId } from "~/domains/bookings/bookingContext.server.ts";

/**
 * SSOT 2.1: GET /proxy/bta/disabled-dates
 * SSOT 6.2: Disabled dates 입력 스키마 (Query)
 * SSOT 8.3: Disabled dates 응답 스키마
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
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
  let validatedInput: DisabledDatesInput | null = null;
  let shop: string | null = null;
  let dateRange: string[] = [];

  try {
    // 4. 쿼리 파라미터 파싱 및 검증
    const url = new URL(request.url);
    const queryParams = parseQueryParams(url);
    validatedInput = disabledDatesSchema.parse(queryParams);

    // 5. shop 정보 추출 (metafield 조회용)
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

    // 6. 날짜 범위 생성 (from~to inclusive, KST 기준)
    dateRange = getDateRange(validatedInput.from, validatedInput.to);

    // 7. 정책을 한 번만 조회 (성능 최적화: 중복 호출 방지)
    const requestParams = {
      bookingMode: validatedInput.bookingMode,
      poolKey: validatedInput.poolKey,
    };
    const policy = await resolveBookingPolicy(productId, shop, requestParams);

    // 8. 전역 블랙아웃 날짜 조회 (range)
    let globalBlackoutDates: string[] = [];
    try {
      const globalBlackouts = await listGlobalBlackouts({
        shop,
        from: validatedInput.from,
        to: validatedInput.to,
      });
      globalBlackoutDates = globalBlackouts.dates;
    } catch (error) {
      console.warn(
        JSON.stringify(
          maskPII({
            correlationId,
            message: "Failed to fetch global blackout dates",
            shop,
            from: validatedInput.from,
            to: validatedInput.to,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }

    // 9. 각 날짜에 대해 availability 체크를 병렬 처리 (pax=1로 고정)
    const availabilityChecks = dateRange.map((date) =>
      checkAvailability({
        productId,
        shop,
        date,
        pax: 1, // disabled-dates는 pax 입력이 없으므로 1로 고정
        bookingMode: validatedInput.bookingMode,
        poolKey: validatedInput.poolKey,
        policy, // 조회한 정책 재사용
      }),
    );

    const availabilityResults = await Promise.all(availabilityChecks);

    // available: false인 날짜를 disabledDates에 추가
    const disabledDates = new Set<string>(globalBlackoutDates);
    for (let i = 0; i < dateRange.length; i++) {
      if (!availabilityResults[i].available) {
        disabledDates.add(dateRange[i]);
      }
    }

    // 10. 중복 제거 및 오름차순 정렬 (getDateRange가 이미 정렬되어 있지만 안전을 위해)
    const uniqueDisabledDates = Array.from(disabledDates).sort();

    // 9. 표준 Envelope로 응답 반환
    return respond.ok({ disabledDates: uniqueDisabledDates }, { correlationId });
  } catch (error) {
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
      console.error(
        JSON.stringify(
          maskPII({
            correlationId,
            message: "Disabled dates 처리 실패",
            errorType: error.name,
            errorMessage: error.message,
            productId: validatedInput?.productId,
            shop,
            from: validatedInput?.from,
            to: validatedInput?.to,
            poolKey: validatedInput?.poolKey,
            bookingMode: validatedInput?.bookingMode,
            dateRangeCount: dateRange.length,
            ...(error.cause instanceof Error
              ? { cause: error.cause.message }
              : error.cause
                ? { cause: error.cause }
                : {}),
          }),
        ),
      );

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
          message: "Disabled dates 엔드포인트 오류",
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
