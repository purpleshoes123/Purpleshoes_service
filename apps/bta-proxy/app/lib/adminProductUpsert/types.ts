export type TicketType = "adult" | "child" | "infant";

export type BookingMode = "private" | "shared";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface FileMeta {
  filename: string;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
}

export interface PriceTableCell {
  ticketType: TicketType;
  unitPrice: number;
}

export interface PriceTableTier {
  paxTier: number;
  cells: Array<PriceTableCell>;
}

export interface PriceTable {
  tiers: Array<PriceTableTier>;
}

export interface TravelProductUpsertInput {
  externalKey: string;
  title: string;
  descriptionHtml: string;
  maxPax: number;
  bookingMode: BookingMode;
  poolKey: string;
  guideUnitsRequired: number;
  startTimeLabel: string;
  bookingWindowDays: number;
  operatingWeekdays: Weekday[];
  blackoutDates: string[];
  pricingTable: PriceTable;
  heroMedia?: FileMeta;
  categoryImage?: FileMeta;
  travelGallery?: FileMeta[];
  publicationIds?: string[];
}

export type TravelProductUpsertRequest = Omit<
  TravelProductUpsertInput,
  "heroMedia" | "categoryImage" | "travelGallery"
> & {
  heroMedia?: FileMeta;
  categoryImage?: FileMeta;
  travelGallery?: FileMeta[];
};
