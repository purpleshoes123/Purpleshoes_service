import type { AttachProductAssetsInput } from "~/lib/adminProductAttachFiles/types";

type MetafieldInput = {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

export function buildMetafieldsForTravel(
  input: AttachProductAssetsInput
): MetafieldInput[] {
  const ownerId = input.productId;

  const metafields: MetafieldInput[] = [
    {
      ownerId,
      namespace: "travel",
      key: "pool_key",
      type: "single_line_text_field",
      value: input.poolKey,
    },
    {
      ownerId,
      namespace: "travel",
      key: "blackout_dates",
      type: "list.single_line_text_field",
      value: JSON.stringify(input.blackoutDates),
    },
    {
      ownerId,
      namespace: "travel",
      key: "guide_units_required",
      type: "number_integer",
      value: String(input.guideUnitsRequired),
    },
    {
      ownerId,
      namespace: "travel",
      key: "booking_mode",
      type: "single_line_text_field",
      value: input.bookingMode,
    },
    {
      ownerId,
      namespace: "travel",
      key: "start_time_label",
      type: "single_line_text_field",
      value: input.startTimeLabel,
    },
    {
      ownerId,
      namespace: "travel",
      key: "operating_weekdays",
      type: "list.single_line_text_field",
      value: JSON.stringify(input.operatingWeekdays),
    },
    {
      ownerId,
      namespace: "travel",
      key: "booking_window_days",
      type: "number_integer",
      value: String(input.bookingWindowDays),
    },
    {
      ownerId,
      namespace: "travel",
      key: "max_pax",
      type: "number_integer",
      value: String(input.maxPax),
    },
  ];

  if (input.categoryImageFileId) {
    metafields.push({
      ownerId,
      namespace: "tour",
      key: "images1",
      type: "file_reference",
      value: input.categoryImageFileId,
    });
  }

  if (input.galleryFileIds && input.galleryFileIds.length > 0) {
    metafields.push({
      ownerId,
      namespace: "custom",
      key: "travel_gallery",
      type: "list.file_reference",
      value: JSON.stringify(input.galleryFileIds),
    });
  }

  return metafields;
}
