import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { getRedisBookingClient } from "~/domains/bookings/bookingStore";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "~/domains/bookings/rebuildStore";
import { respond, withNoStore } from "~/lib/respond";

export const BOOKING_OWNER_QUERY = `
  query currentBookingOwner($id: ID!) {
    order(id: $id) { customer { id } }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const fail = (status: number, message: string) =>
    withNoStore(respond.fail("BOOKING_LOOKUP_FAILED", message, undefined, status, correlationId));
  const limited = await enforceRateLimit(request);
  if (limited) {
    return withNoStore(limited);
  }
  const verified = await verifyAppProxy(request);
  if (verified) {
    return withNoStore(verified);
  }
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id") || "";
  const shop = extractShopFromRequest(request);
  if (!shop || !/^[1-9]\d*$/.test(customerId)) {
    return fail(401, "Please sign in.");
  }
  const orderId = url.searchParams.get("orderId") || "";
  const lineItemId = url.searchParams.get("lineItemId") || "";
  if (!/^[1-9]\d*$/.test(orderId) || !/^[1-9]\d*$/.test(lineItemId)) {
    return fail(400, "Invalid booking reference.");
  }
  try {
    const admin = await getAdminApiClient(shop);
    if (!admin) {
      return fail(503, "Booking information is temporarily unavailable.");
    }
    const response = await admin.graphql(BOOKING_OWNER_QUERY, {
      variables: { id: `gid://shopify/Order/${orderId}` },
    });
    if (!response.ok) {
      throw new Error("Order lookup failed");
    }
    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error("Order lookup failed");
    }
    if (payload.data?.order?.customer?.id !== `gid://shopify/Customer/${customerId}`) {
      return fail(404, "Booking not found.");
    }
    const redis = getRedisBookingClient();
    if (!redis) {
      return fail(503, "Booking information is temporarily unavailable.");
    }
    const bookingId = await redis.get(RebuildStoreKeys.orderLineIndex(shop, orderId, lineItemId));
    if (!bookingId) {
      return fail(404, "Booking not found.");
    }
    const raw = await redis.get(RebuildStoreKeys.confirmedBooking(shop, bookingId));
    const booking: ConfirmedBookingRecord | null = raw ? JSON.parse(raw) : null;
    if (
      !booking ||
      booking.shop !== shop ||
      booking.orderId !== orderId ||
      booking.bookingId !== bookingId ||
      booking.status !== "confirmed" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(booking.travelDate)
    ) {
      return fail(503, "Booking information is temporarily unavailable.");
    }
    return withNoStore(
      respond.ok({ orderId, lineItemId, travelDate: booking.travelDate }, { correlationId }),
    );
  } catch {
    return fail(503, "Booking information is temporarily unavailable.");
  }
};
