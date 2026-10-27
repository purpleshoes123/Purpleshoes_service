import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getRedisBookingClient } from "./bookingStore";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "./rebuildStore";
import { getOrderSummary, type OrderSummary } from "./adminOrderService";
import { fetchOrderLineItemsGraphQL } from "./shopifyAdmin";
import {
  extractBookingExtrasFromLineItems,
  type BookingExtras,
} from "./bookingExtras";

export type BookingDetailData = {
  booking: ConfirmedBookingRecord;
  order: OrderSummary | null;
  orderUrl: string | null;
  bookingExtras: BookingExtras | null;
};

export class BookingDetailError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function buildFallbackOrderUrl(shop: string, orderId: string): string | null {
  if (!orderId || orderId.startsWith("gid://")) {
    return null;
  }
  return `https://${shop}/admin/orders/${orderId}`;
}

export async function getBookingDetailData(params: {
  shop: string;
  admin?: AdminApiContext | null;
  bookingId?: string | null;
}): Promise<BookingDetailData> {
  const { shop, admin, bookingId } = params;

  if (!bookingId) {
    throw new BookingDetailError("bookingId가 없습니다.", 400);
  }

  const redisClient = getRedisBookingClient();
  if (!redisClient) {
    throw new BookingDetailError("Redis Booking Store가 필요합니다.", 500);
  }

  const bookingKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);
  const bookingData = await redisClient.get(bookingKey);
  if (!bookingData) {
    throw new BookingDetailError("bookingId를 찾을 수 없습니다.", 404);
  }

  let booking: ConfirmedBookingRecord;
  try {
    booking = JSON.parse(bookingData) as ConfirmedBookingRecord;
  } catch {
    throw new BookingDetailError("booking 레코드 파싱 실패", 500);
  }

  let orderSummary: OrderSummary | null = null;
  try {
    orderSummary = await getOrderSummary({
      shop,
      orderId: booking.orderId,
      admin: admin ?? undefined,
    });
  } catch {
    orderSummary = null;
  }

  let bookingExtras: BookingExtras | null = null;
  if (admin) {
    try {
      const lineItems = await fetchOrderLineItemsGraphQL(admin, booking.orderId);
      bookingExtras = extractBookingExtrasFromLineItems(booking, lineItems);
    } catch {
      bookingExtras = null;
    }
  }

  return {
    booking,
    order: orderSummary,
    orderUrl: orderSummary?.adminUrl || buildFallbackOrderUrl(shop, booking.orderId),
    bookingExtras,
  };
}
