/**
 * Booking key helpers.
 */

export function makeSlotKey(productId: string, travelDate: string): string {
  return `${productId}|${travelDate}`;
}
