import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getRedisBookingClient } from "~/lib/bookingStore";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "~/lib/rebuildStore";
import { getOrderSummary } from "~/lib/adminOrderService";

function buildFallbackOrderUrl(shop: string, orderId: string): string | null {
  if (!orderId || orderId.startsWith("gid://")) {
    return null;
  }
  return `https://${shop}/admin/orders/${orderId}`;
}
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  try {
    const bookingId = params.bookingId;
    if (!bookingId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "bookingId는 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin = undefined;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) return authResponse;

      const url = new URL(request.url);
      shop = url.searchParams.get("shop");
      if (!shop) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
        );
      }

      if (!shop.includes(".")) {
        shop = `${shop}.myshopify.com`;
      }
    } else {
      try {
        const auth = await authenticate.admin(request);
        shop = auth.session.shop;
        admin = auth.admin;
      } catch (error) {
        if (error instanceof Response) {
          return respond.fail(
            ErrorCode.INTERNAL_AUTH_INVALID,
            getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID),
            undefined,
            getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
            correlationId
          );
        }
        throw error;
      }
    }

    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const redisClient = getRedisBookingClient();
    if (!redisClient) {
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(
          ErrorCode.INTERNAL_ERROR,
          "Redis Booking Store가 필요합니다."
        ),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId
      );
    }

    const bookingKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);
    const bookingData = await redisClient.get(bookingKey);
    if (!bookingData) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "bookingId를 찾을 수 없습니다."),
        undefined,
        404,
        correlationId
      );
    }

    let booking: ConfirmedBookingRecord;
    try {
      booking = JSON.parse(bookingData) as ConfirmedBookingRecord;
    } catch {
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(ErrorCode.INTERNAL_ERROR, "booking 레코드 파싱 실패"),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId
      );
    }

    let orderSummary = null;
    try {
      orderSummary = await getOrderSummary({
        shop,
        orderId: booking.orderId,
        admin,
      });
    } catch {
      orderSummary = null;
    }

    return respond.ok(
      {
        booking,
        order: orderSummary,
        orderUrl: orderSummary?.adminUrl || buildFallbackOrderUrl(shop, booking.orderId),
      },
      { correlationId }
    );
  } catch (error) {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
