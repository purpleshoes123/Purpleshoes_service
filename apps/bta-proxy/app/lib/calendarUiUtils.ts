export function sliceBookings<T>(
  bookings: T[],
  maxPerDay: number
): { visible: T[]; hiddenCount: number } {
  const limit = Math.max(0, maxPerDay);
  if (bookings.length <= limit) {
    return { visible: bookings, hiddenCount: 0 };
  }
  return {
    visible: bookings.slice(0, limit),
    hiddenCount: bookings.length - limit,
  };
}
