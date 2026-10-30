import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getDateRange } from "~/lib/dateUtils";
import { listGlobalBlackouts } from "~/lib/shopifyAdmin";
import { getBlackoutDates } from "~/domains/bookings/blackoutService";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "~/domains/bookings/rebuildStore";
import { getRedisBookingClient } from "~/domains/bookings/bookingStore";

export type CalendarBookingSummary = {
  bookingId: string;
  groupKey: string;
  orderId: string;
  productId: string;
  productTitle?: string;
  travelDate: string;
  poolKey: string;
  bookingMode: "private" | "shared";
  status?: string;
  travelers?: {
    adult: number;
    child: number;
    infant: number;
  };
};

export type CalendarDayItem = {
  travelDate: string;
  bookings: CalendarBookingSummary[];
};

export type CalendarResult = {
  dates: string[];
  items: CalendarDayItem[];
  blackouts: string[];
  summary?: {
    bookingsCount: number;
    missingRecordCount: number;
    parseErrorCount: number;
  };
};

function summarizeBooking(record: ConfirmedBookingRecord): CalendarBookingSummary {
  return {
    bookingId: record.bookingId,
    groupKey: record.groupKey,
    orderId: record.orderId,
    productId: record.productId,
    productTitle: record.productTitle,
    travelDate: record.travelDate,
    poolKey: record.poolKey,
    bookingMode: record.bookingMode,
    status: record.status,
    travelers: record.travelers,
  };
}

async function loadBookingRecords(
  redisClient: any,
  shop: string,
  bookingIds: string[],
): Promise<{
  records: ConfirmedBookingRecord[];
  missingCount: number;
  parseErrorCount: number;
}> {
  if (bookingIds.length === 0) {
    return { records: [], missingCount: 0, parseErrorCount: 0 };
  }
  const bookingKeys = bookingIds.map((id) => RebuildStoreKeys.confirmedBooking(shop, id));
  let payloads: Array<string | null> = [];
  if (bookingKeys.length === 1) {
    payloads = [await redisClient.get(bookingKeys[0])];
  } else if (typeof redisClient.mget === "function") {
    payloads = await redisClient.mget(...bookingKeys);
  } else {
    payloads = await Promise.all(bookingKeys.map((key) => redisClient.get(key)));
  }

  const records: ConfirmedBookingRecord[] = [];
  let missingCount = 0;
  let parseErrorCount = 0;
  for (const payload of payloads) {
    if (!payload) {
      missingCount += 1;
      continue;
    }
    try {
      const record = JSON.parse(payload) as ConfirmedBookingRecord;
      records.push(record);
    } catch {
      parseErrorCount += 1;
    }
  }
  return { records, missingCount, parseErrorCount };
}

export async function listAdminCalendar(params: {
  shop: string;
  from: string;
  to: string;
  poolKey?: string;
  productId?: string;
  admin?: AdminApiContext;
  redisClient?: any;
}): Promise<CalendarResult> {
  const redisClient = params.redisClient || getRedisBookingClient();
  if (!redisClient) {
    throw new Error("REDIS_BOOKING_STORE_REQUIRED");
  }

  const dateRange = getDateRange(params.from, params.to);
  const rangeSet = new Set(dateRange);
  const items: CalendarDayItem[] = [];
  const bookingDateSet = new Set<string>();
  let bookingsCount = 0;
  let missingRecordCount = 0;
  let parseErrorCount = 0;

  for (const date of dateRange) {
    const indexKey = params.poolKey
      ? RebuildStoreKeys.poolIndex(params.shop, `${params.poolKey}|${date}`)
      : RebuildStoreKeys.dateIndex(params.shop, date);
    const bookingIds = await redisClient.smembers(indexKey);
    if (!bookingIds || bookingIds.length === 0) {
      continue;
    }
    const loaded = await loadBookingRecords(redisClient, params.shop, bookingIds);
    missingRecordCount += loaded.missingCount;
    parseErrorCount += loaded.parseErrorCount;
    let records = loaded.records;
    if (params.productId) {
      records = records.filter((record) => record.productId === params.productId);
    }
    if (records.length === 0) {
      continue;
    }
    const summaries = records
      .map(summarizeBooking)
      .filter((booking) => booking.travelDate === date);
    if (summaries.length === 0) {
      continue;
    }
    summaries.sort((a, b) => a.bookingId.localeCompare(b.bookingId));
    items.push({ travelDate: date, bookings: summaries });
    bookingsCount += summaries.length;
    bookingDateSet.add(date);
  }

  items.sort((a, b) => a.travelDate.localeCompare(b.travelDate));

  const globalBlackouts = await listGlobalBlackouts({
    admin: params.admin,
    shop: params.shop,
    from: params.from,
    to: params.to,
  });

  const blackoutSet = new Set<string>();
  for (const date of globalBlackouts.dates || []) {
    if (rangeSet.has(date)) {
      blackoutSet.add(date);
    }
  }

  if (params.productId) {
    const dates = await getBlackoutDates(params.productId, params.shop);
    for (const date of dates) {
      if (rangeSet.has(date)) {
        blackoutSet.add(date);
      }
    }
  }

  const blackoutDates = Array.from(blackoutSet).sort();
  const allDates = new Set<string>(blackoutDates);
  for (const date of bookingDateSet) {
    allDates.add(date);
  }

  return {
    dates: Array.from(allDates).sort(),
    items,
    blackouts: blackoutDates,
    summary: {
      bookingsCount,
      missingRecordCount,
      parseErrorCount,
    },
  };
}
