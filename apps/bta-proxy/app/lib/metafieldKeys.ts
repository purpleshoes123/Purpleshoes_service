/**
 * Metafield 키 상수 정의
 * Admin Metafield 정의와 100% 일치하도록 유지
 */

/**
 * Product Metafields (namespace: travel)
 */
export const PRODUCT_NS = "travel";

export const PRODUCT_KEYS = {
  maxPax: "max_pax",
  bookingWindowDays: "booking_window_days",
  operatingWeekdays: "operating_weekdays",
  startTimeLabel: "start_time_label",
  bookingMode: "booking_mode",
  guideUnitsRequired: "guide_units_required",
  blackoutDates: "blackout_dates",
  poolKey: "pool_key",
} as const;

/**
 * Shop Metafields (namespace: booking)
 */
export const SHOP_NS = "booking";

export const SHOP_KEYS = {
  defaultPoolKey: "default_pool_key",
  poolsCapacityJson: "pools_capacity_json",
  poolsLabelJson: "pools_label_json",
  defaultGuideUnitsRequired: "default_guide_units_required",
} as const;

