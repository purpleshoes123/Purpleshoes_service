import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: import("@shopify/ui-extensions/purchase.checkout.cart-line-list.render-after").Api;

type CartAttribute = { key: string; value: string };

type BookingDetails = {
  title: string;
  date?: string;
  travelers?: string;
  startTime?: string;
  duration?: string;
  pickup?: string;
  dietary?: string;
  contact?: string;
};

export default function extension() {
  render(<CheckoutTourBookingSummary />, document.body);
}

function CheckoutTourBookingSummary() {
  const bookingDetails = findTourBookingDetails(shopify.lines.value);

  if (bookingDetails.length === 0) {
    return null;
  }

  return (
    <s-stack gap="small" direction="block">
      <s-divider />
      {bookingDetails.map((booking) => (
        <s-stack gap="small-100" direction="block" key={`${booking.title}-${booking.date || ""}`}>
          <s-text type="strong">Tour booking details</s-text>
          <s-text>{booking.title}</s-text>
          {booking.date ? <Detail label="Date" value={booking.date} /> : null}
          {booking.travelers ? <Detail label="Travelers" value={booking.travelers} /> : null}
          {booking.startTime ? <Detail label="Start time" value={booking.startTime} /> : null}
          {booking.duration ? <Detail label="Duration" value={booking.duration} /> : null}
          {booking.pickup ? <Detail label="Pickup location" value={booking.pickup} /> : null}
          {booking.dietary ? <Detail label="Dietary requests" value={booking.dietary} /> : null}
          {booking.contact ? <Detail label="Reservation contact" value={booking.contact} /> : null}
        </s-stack>
      ))}
    </s-stack>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <s-text>
      {label}: {value}
    </s-text>
  );
}

function findTourBookingDetails(
  lines: Array<{ merchandise: { title: string }; attributes: CartAttribute[] }>,
): BookingDetails[] {
  const seen = new Set<string>();
  const bookings: BookingDetails[] = [];

  for (const line of lines) {
    const attributes = new Map(line.attributes.map(({ key, value }) => [key, value]));
    const date = firstAttribute(attributes, [
      "travel_date",
      "booking_date",
      "Booking Date",
      "Date",
    ]);
    const travelers = firstAttribute(attributes, ["traveler_summary"]);
    const pickup = firstAttribute(attributes, ["pickup_location"]);
    const dietary = firstAttribute(attributes, ["dietary_restrictions"]);

    // Only tour lines carry booking metadata. Grouped adult/teen/infant lines
    // share this metadata, so render their booking once in the order summary.
    if (!date && !travelers && !pickup && !dietary) {
      continue;
    }

    const group =
      firstAttribute(attributes, ["booking_group_id"]) ||
      [line.merchandise.title, date || "", travelers || "", pickup || ""].join("|");
    if (seen.has(group)) {
      continue;
    }
    seen.add(group);

    const contactName = firstAttribute(attributes, ["reservation_contact_name"]);
    const contactPhone = firstAttribute(attributes, ["reservation_contact_phone_e164"]);
    bookings.push({
      title: line.merchandise.title,
      date,
      travelers,
      startTime: firstAttribute(attributes, ["start_time_label"]),
      duration: firstAttribute(attributes, ["tour_duration"]),
      pickup,
      dietary,
      contact: [contactName, contactPhone].filter(Boolean).join(" / ") || undefined,
    });
  }

  return bookings;
}

function firstAttribute(attributes: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attributes.get(key)?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
