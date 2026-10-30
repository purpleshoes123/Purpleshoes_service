import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type { BookingMode, Weekday } from "~/domains/catalog/adminProductUpsert/types";
import { fetchProductByExternalKey } from "~/domains/catalog/adminProductRead/fetchProductByExternalKey";
import {
  PRODUCT_LOAD_QUERY,
  mapProductLoad,
  type ProductLoadBase,
} from "~/domains/catalog/adminProductLoad/productLoadQuery";

const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type ProductLoadResult = {
  productId: string;
  status?: string;
  title: string;
  descriptionHtml: string;
  externalKey?: string;
  poolKey?: string;
  blackoutDates: string[];
  guideUnitsRequired?: number;
  bookingMode?: BookingMode;
  startTimeLabel?: string;
  operatingWeekdays: Weekday[];
  bookingWindowDays?: number;
  maxPax?: number;
  categoryImageFileId?: string;
  galleryFileIds?: string[];
  heroMediaId?: string;
  warnings: string[];
};

function getMetafieldValue(
  metafields: ProductLoadBase["metafields"],
  namespace: string,
  key: string,
): string | null {
  return (
    metafields.find((field) => field.namespace === namespace && field.key === key)?.value ?? null
  );
}

function parseJsonArray(value: string | null, warnings: string[], label: string): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
    warnings.push(`${label} 형식이 배열이 아닙니다.`);
    return [];
  } catch {
    warnings.push(`${label} JSON 파싱 실패`);
    return [];
  }
}

function parseInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

function normalizeWeekdays(values: string[]): Weekday[] {
  const set = new Set(values.map((value) => value.trim().toLowerCase()));
  return WEEKDAYS.filter((day) => set.has(day));
}

function normalizeBookingMode(value: string | null): BookingMode | undefined {
  if (value === "private" || value === "shared") {
    return value;
  }
  return undefined;
}

function buildProductLoadResult(base: ProductLoadBase): ProductLoadResult {
  const warnings: string[] = [];

  const externalKeyValue = getMetafieldValue(base.metafields, "travel", "external_key");
  const poolKey = getMetafieldValue(base.metafields, "travel", "pool_key") ?? undefined;
  const blackoutDates = parseJsonArray(
    getMetafieldValue(base.metafields, "travel", "blackout_dates"),
    warnings,
    "blackout_dates",
  );
  const guideUnitsRequired = parseInteger(
    getMetafieldValue(base.metafields, "travel", "guide_units_required"),
  );
  const bookingMode = normalizeBookingMode(
    getMetafieldValue(base.metafields, "travel", "booking_mode"),
  );
  const startTimeLabel =
    getMetafieldValue(base.metafields, "travel", "start_time_label") ?? undefined;
  const operatingWeekdays = normalizeWeekdays(
    parseJsonArray(
      getMetafieldValue(base.metafields, "travel", "operating_weekdays"),
      warnings,
      "operating_weekdays",
    ),
  );
  const bookingWindowDays = parseInteger(
    getMetafieldValue(base.metafields, "travel", "booking_window_days"),
  );
  const maxPax = parseInteger(getMetafieldValue(base.metafields, "travel", "max_pax"));
  const categoryImageFileId = getMetafieldValue(base.metafields, "tour", "images1") ?? undefined;
  const galleryFileIds = parseJsonArray(
    getMetafieldValue(base.metafields, "custom", "travel_gallery"),
    warnings,
    "travel_gallery",
  );

  return {
    productId: base.productId,
    status: base.status,
    title: base.title,
    descriptionHtml: base.descriptionHtml,
    externalKey: externalKeyValue ?? undefined,
    poolKey,
    blackoutDates,
    guideUnitsRequired,
    bookingMode,
    startTimeLabel,
    operatingWeekdays,
    bookingWindowDays,
    maxPax,
    categoryImageFileId,
    galleryFileIds: galleryFileIds.length > 0 ? galleryFileIds : undefined,
    heroMediaId: base.heroMediaId,
    warnings,
  };
}

async function fetchProductLoadBase(
  adminClient: AdminApiContext,
  productId: string,
): Promise<ProductLoadBase> {
  const response = await adminClient.graphql(PRODUCT_LOAD_QUERY, {
    variables: { id: productId },
  });

  if (!response.ok) {
    throw new Error("Shopify Admin GraphQL product load 실패");
  }

  const json = await response.json();
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error: { message?: string }) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      errorMessage
        ? `Shopify Admin GraphQL product load 실패: ${errorMessage}`
        : "Shopify Admin GraphQL product load 실패",
    );
  }

  return mapProductLoad(json);
}

export async function loadProductByExternalKey(
  adminClient: AdminApiContext,
  externalKey: string,
): Promise<ProductLoadResult | null> {
  const existing = await fetchProductByExternalKey(adminClient, externalKey);
  if (!existing?.id) {
    return null;
  }

  const base = await fetchProductLoadBase(adminClient, existing.id);
  return buildProductLoadResult(base);
}

export async function loadProductByProductId(
  adminClient: AdminApiContext,
  productId: string,
): Promise<ProductLoadResult> {
  const base = await fetchProductLoadBase(adminClient, productId);
  return buildProductLoadResult(base);
}
