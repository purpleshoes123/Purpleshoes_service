import type { ConfirmedBookingRecord } from "./rebuildStore";
import { createGroupKey } from "./groupKey";

export type BookingExtras = {
  pickupLocation: string | null;
  dietaryRestrictions: string | null;
  reservationContactName: string | null;
  reservationContactPhone: string | null;
  mismatch: boolean;
};

type LineItemProperty = { name: string; value: string };
type LineItemWithProperties = {
  product_id?: string;
  properties?: LineItemProperty[];
};

const PROPERTY_KEYS = {
  travelDate: ["travel_date", "travelDate"],
  bookingMode: ["booking_mode", "bookingMode"],
  poolKey: ["pool_key", "poolKey"],
  holdId: ["hold_id", "holdId"],
  pickupLocation: ["pickup_location"],
  dietaryRestrictions: ["dietary_restrictions"],
  reservationContactName: ["reservation_contact_name"],
  reservationContactPhone: ["reservation_contact_phone_e164"],
};

function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function readProperty(properties: LineItemProperty[] | undefined, keys: string[]): string | null {
  if (!properties || properties.length === 0) {
    return null;
  }
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  const found = properties.find((prop) => keySet.has(String(prop.name).toLowerCase()));
  return normalizeValue(found?.value);
}

function matchesBooking(
  booking: ConfirmedBookingRecord,
  lineItem: LineItemWithProperties,
): boolean {
  const properties = lineItem.properties || [];
  const travelDate = readProperty(properties, PROPERTY_KEYS.travelDate);
  if (!travelDate) {
    return false;
  }

  const productId = lineItem.product_id ? String(lineItem.product_id) : "";
  if (!productId || productId !== booking.productId) {
    return false;
  }

  const bookingModeRaw = readProperty(properties, PROPERTY_KEYS.bookingMode);
  const bookingMode = bookingModeRaw ? bookingModeRaw.toLowerCase() : null;
  const poolKey = readProperty(properties, PROPERTY_KEYS.poolKey);
  const holdId = readProperty(properties, PROPERTY_KEYS.holdId);

  const lineItemGroupKey = createGroupKey({
    travelDate,
    productId,
    poolKey: poolKey || undefined,
    bookingMode:
      bookingMode === "shared" ? "shared" : bookingMode === "private" ? "private" : undefined,
    holdId: holdId || undefined,
  });

  return lineItemGroupKey === booking.groupKey;
}

function pickFirstValue(values: string[]): {
  value: string | null;
  mismatch: boolean;
} {
  if (values.length === 0) {
    return { value: null, mismatch: false };
  }
  const unique = Array.from(new Set(values));
  return {
    value: unique[0],
    mismatch: unique.length > 1,
  };
}

export function extractBookingExtrasFromLineItems(
  booking: ConfirmedBookingRecord,
  lineItems: LineItemWithProperties[],
): BookingExtras | null {
  if (!lineItems || lineItems.length === 0) {
    return null;
  }

  const matched = lineItems.filter((item) => matchesBooking(booking, item));

  if (matched.length === 0) {
    return null;
  }

  const pickupValues: string[] = [];
  const dietaryValues: string[] = [];
  const reservationContactNameValues: string[] = [];
  const reservationContactPhoneValues: string[] = [];

  for (const item of matched) {
    const pickup = readProperty(item.properties, PROPERTY_KEYS.pickupLocation);
    if (pickup) {
      pickupValues.push(pickup);
    }
    const dietary = readProperty(item.properties, PROPERTY_KEYS.dietaryRestrictions);
    if (dietary) {
      dietaryValues.push(dietary);
    }
    const reservationContactName = readProperty(
      item.properties,
      PROPERTY_KEYS.reservationContactName,
    );
    if (reservationContactName) {
      reservationContactNameValues.push(reservationContactName);
    }
    const reservationContactPhone = readProperty(
      item.properties,
      PROPERTY_KEYS.reservationContactPhone,
    );
    if (reservationContactPhone) {
      reservationContactPhoneValues.push(reservationContactPhone);
    }
  }

  const pickupResult = pickFirstValue(pickupValues);
  const dietaryResult = pickFirstValue(dietaryValues);
  const reservationContactNameResult = pickFirstValue(reservationContactNameValues);
  const reservationContactPhoneResult = pickFirstValue(reservationContactPhoneValues);

  return {
    pickupLocation: pickupResult.value,
    dietaryRestrictions: dietaryResult.value,
    reservationContactName: reservationContactNameResult.value,
    reservationContactPhone: reservationContactPhoneResult.value,
    mismatch:
      pickupResult.mismatch ||
      dietaryResult.mismatch ||
      reservationContactNameResult.mismatch ||
      reservationContactPhoneResult.mismatch,
  };
}
