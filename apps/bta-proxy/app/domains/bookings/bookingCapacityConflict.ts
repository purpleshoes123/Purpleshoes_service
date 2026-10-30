/** Only throw before any capacity effect, or after a confirmed EXEC=null.
 * Never use this for transport errors, partial EXEC results or lost replies. */
export class BookingCapacityConflict extends Error {
  constructor() {
    super("Booking destination is no longer available");
  }
}
