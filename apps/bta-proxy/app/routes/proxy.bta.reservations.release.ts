import type { ActionFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { releaseHoldSchema } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { maskPII } from "~/lib/masking";

/**
 * SSOT 2.1: POST /proxy/bta/reservations/release
 * Hold 해제 엔드포인트
 * Theme에서 cart clear 직전에 호출하여 ghost hold가 남지 않도록 함
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
    const validatedInput = releaseHoldSchema.parse(body);

    // 5. Booking Store 가져오기
    const store = getBookingStore();

    // 6. Hold 해제 (멱등성 보장: hold가 없어도 ok:true 반환)
    try {
      await store.releaseHold(validatedInput.holdId);

      // 7. 성공 응답 반환
      return respond.ok({ released: true }, { correlationId });
    } catch (releaseError) {
      // Redis 오류 등 내부 에러 처리
      if (releaseError instanceof Error) {
        // 타임아웃 에러
        if (releaseError.message.includes("timeout") || releaseError.name === "TimeoutError") {
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

      // 알 수 없는 에러는 INTERNAL_ERROR로 처리
      throw releaseError;
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

    // 기타 에러 (PII 마스킹)
    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Hold release 엔드포인트 오류",
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
