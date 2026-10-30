import type { BookingMode, Weekday } from "~/domains/catalog/adminProductUpsert/types";

/**
 * fileId는 Shopify GID 형식(예: gid://shopify/File/...)을 가정합니다.
 */
export type AttachProductAssetsInput = {
  productId: string;
  heroFileId?: string;
  heroPreviewUrl?: string;
  categoryImageFileId?: string;
  galleryFileIds?: string[];
  poolKey: string;
  blackoutDates: string[];
  guideUnitsRequired: number;
  bookingMode: BookingMode;
  startTimeLabel: string;
  operatingWeekdays: Weekday[];
  bookingWindowDays: number;
  maxPax: number;
};

export type AttachResult = {
  productId: string;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
};
