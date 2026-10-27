export type BookingStatus =
  | "confirmed"
  | "cancelled"
  | "refunded"
  | "partial_refunded"
  | "unknown";

export type BookingStatusDisplay = {
  label: string;
  tone: "success" | "critical" | "attention" | "info";
};

export function normalizeBookingStatus(value?: string | null): BookingStatus {
  if (!value) {
    return "confirmed";
  }
  const normalized = value.toLowerCase();
  if (normalized === "confirmed") return "confirmed";
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "refunded") return "refunded";
  if (
    normalized === "partial_refunded" ||
    normalized === "partially_refunded"
  ) {
    return "partial_refunded";
  }
  return "unknown";
}

export function getBookingStatusDisplay(
  status: BookingStatus
): BookingStatusDisplay {
  switch (status) {
    case "confirmed":
      return { label: "확정", tone: "success" };
    case "cancelled":
      return { label: "취소", tone: "critical" };
    case "refunded":
      return { label: "환불", tone: "critical" };
    case "partial_refunded":
      return { label: "부분 환불", tone: "attention" };
    default:
      return { label: "미확인", tone: "attention" };
  }
}
