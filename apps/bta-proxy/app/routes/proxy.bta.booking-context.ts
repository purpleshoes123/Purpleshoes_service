import type { LoaderFunctionArgs } from "react-router";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { issueBookingContext } from "~/domains/bookings/bookingContext.server.ts";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";

/** Issues a short-lived opaque reference for booking requests from a product page. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) {
    return verifyResponse;
  }

  const correlationId = respond.getCorrelationId(request);
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

  try {
    const bookingContext = await issueBookingContext(request, shop);
    if (!bookingContext) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        "예약 상품 정보를 확인할 수 없습니다.",
        undefined,
        400,
        correlationId,
      );
    }
    return respond.ok({ bookingContext, expiresIn: 30 * 60 }, { correlationId });
  } catch (error) {
    console.error("Failed to issue booking context", error);
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
