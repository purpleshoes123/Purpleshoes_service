import { getRedisBookingClient } from "~/domains/bookings/bookingStore";
import { runRedisTransaction } from "~/lib/redisTransaction";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "~/domains/bookings/rebuildStore";
import { makeSlotKey } from "~/domains/bookings/bookingKeys";
import { checkEligibility, normalizeBookingInput } from "~/domains/bookings/bookingEligibility";
import { upsertOrderTravelDateMetafield } from "~/domains/bookings/orderMetafieldService";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { withDurableBookingMutation } from "~/domains/bookings/bookingMutation.server.ts";
import { mutateRedisBookingCapacity } from "~/domains/bookings/redisBookingCapacityMutation";
import { BookingCapacityConflict } from "~/domains/bookings/bookingCapacityConflict";

export type RescheduleErrorCode =
  | "BOOKING_NOT_FOUND"
  | "INVALID_DATE_FORMAT"
  | "SAME_DATE"
  | "DATE_IN_PAST"
  | "ELIGIBILITY_CONFLICT"
  | "INTERNAL_ERROR";

export type RescheduleResult =
  | { ok: true; warningMessage?: string }
  | { ok: false; code: RescheduleErrorCode; message: string; field?: "newTravelDate" };

export type RescheduleArgs = {
  shop: string;
  bookingId: string;
  newTravelDate: string;
  nowIso: string;
};

export async function rescheduleBookingTravelDate(args: RescheduleArgs): Promise<RescheduleResult> {
  const { shop, bookingId, newTravelDate, nowIso } = args;
  const durable = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
  const redisClient = getRedisBookingClient();
  if (!redisClient) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: "예약 데이터를 처리할 수 없습니다.",
    };
  }

  if (!newTravelDate) {
    return {
      ok: false,
      code: "INVALID_DATE_FORMAT",
      message: "새로운 여행일을 입력해 주세요.",
      field: "newTravelDate",
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(newTravelDate)) {
    return {
      ok: false,
      code: "INVALID_DATE_FORMAT",
      message: "날짜 형식이 올바르지 않습니다.",
      field: "newTravelDate",
    };
  }

  const confirmedKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);
  const raw = await redisClient.get(confirmedKey);
  if (!raw) {
    return {
      ok: false,
      code: "BOOKING_NOT_FOUND",
      message: "예약 정보를 찾을 수 없습니다.",
    };
  }

  let booking: ConfirmedBookingRecord;
  try {
    booking = JSON.parse(raw) as ConfirmedBookingRecord;
  } catch {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: "예약 정보를 해석할 수 없습니다.",
    };
  }

  const oldTravelDate = booking.travelDate;
  if (newTravelDate === oldTravelDate) {
    return {
      ok: false,
      code: "SAME_DATE",
      message: "기존 여행일과 동일합니다.",
      field: "newTravelDate",
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (newTravelDate < today) {
    return {
      ok: false,
      code: "DATE_IN_PAST",
      message: "과거 날짜로는 변경할 수 없습니다.",
      field: "newTravelDate",
    };
  }

  const travelerTotal =
    (booking.travelers?.adult || 0) +
    (booking.travelers?.child || 0) +
    (booking.travelers?.infant || 0);
  const pax = travelerTotal > 0 ? travelerTotal : 1;

  if (!booking.productId || !booking.bookingMode || !booking.poolKey) {
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: "예약 정보를 확인할 수 없습니다.",
    };
  }

  const eligibilityInput = await normalizeBookingInput({
    productId: booking.productId,
    shop,
    date: newTravelDate,
    pax,
    bookingMode: booking.bookingMode,
    poolKey: booking.poolKey,
    guideUnitsRequired: booking.guideUnitsRequired,
  });
  const eligibility = await checkEligibility(eligibilityInput);
  if (
    durable &&
    (eligibilityInput.bookingMode !== booking.bookingMode ||
      eligibilityInput.poolKey !== booking.poolKey ||
      eligibilityInput.guideUnitsRequired !== booking.guideUnitsRequired)
  ) {
    return {
      ok: false,
      code: "ELIGIBILITY_CONFLICT",
      message: "예약 정책이 변경되어 확인이 필요합니다.",
      field: "newTravelDate",
    };
  }
  if (!eligibility.available) {
    return {
      ok: false,
      code: "ELIGIBILITY_CONFLICT",
      message: eligibility.message || "선택한 날짜에 예약이 불가합니다.",
      field: "newTravelDate",
    };
  }

  const oldSlotKey = makeSlotKey(booking.productId, oldTravelDate);
  const newSlotKey = makeSlotKey(booking.productId, newTravelDate);
  const oldSlotIndexKey = RebuildStoreKeys.slotIndex(shop, oldSlotKey);
  const oldSlotCount = durable ? 0 : await redisClient.scard(oldSlotIndexKey);
  const shouldDeleteOldLegacyConfirmed = !durable && oldSlotKey !== newSlotKey && oldSlotCount <= 1;

  const updatedRecord: ConfirmedBookingRecord = {
    ...booking,
    travelDate: newTravelDate,
    updatedAt: nowIso,
  };

  console.log(
    JSON.stringify({
      message: "Reschedule attempt",
      shop,
      bookingId,
      oldDate: oldTravelDate,
      newDate: newTravelDate,
    }),
  );

  try {
    await withDurableBookingMutation(
      { shop, bookingId, kind: "RESCHEDULE", before: booking, after: updatedRecord },
      async () => {
        if (durable) {
          await mutateRedisBookingCapacity(
            redisClient,
            { shop, orderId: booking.orderId, groupKey: booking.groupKey },
            {
              fromDate: oldTravelDate,
              toDate: newTravelDate,
              capacityUnits: eligibilityInput.policy.poolCapacity,
            },
          );
        }
        return runRedisTransaction(redisClient, (tx: any) => {
          tx.set(confirmedKey, JSON.stringify(updatedRecord));
          tx.srem(RebuildStoreKeys.dateIndex(shop, oldTravelDate), bookingId);
          tx.sadd(RebuildStoreKeys.dateIndex(shop, newTravelDate), bookingId);
          tx.srem(oldSlotIndexKey, bookingId);
          tx.sadd(RebuildStoreKeys.slotIndex(shop, newSlotKey), bookingId);

          if (booking.poolKey) {
            tx.srem(
              RebuildStoreKeys.poolIndex(shop, `${booking.poolKey}|${oldTravelDate}`),
              bookingId,
            );
            tx.sadd(
              RebuildStoreKeys.poolIndex(shop, `${booking.poolKey}|${newTravelDate}`),
              bookingId,
            );
          }

          // The watched capacity transaction already owns these effects in
          // multi-node mode; keep this legacy branch for single-node only.
          if (!durable) {
            tx.set(`confirmed:${newSlotKey}`, "1");
            if (shouldDeleteOldLegacyConfirmed) {
              tx.del(`confirmed:${oldSlotKey}`);
            }
            const units = Number(booking.guideUnitsRequired || 0);
            if (Number.isNaN(units) || units <= 0) {
              throw new Error("Invalid guideUnitsRequired");
            }
            tx.decrby(`pool:${booking.poolKey}|${oldTravelDate}`, units);
            tx.incrby(`pool:${booking.poolKey}|${newTravelDate}`, units);
            if (booking.orderId && booking.groupKey) {
              const legacyKey = `confirmed:${shop}|${booking.orderId}|${booking.groupKey}`;
              tx.set(
                legacyKey,
                JSON.stringify({
                  shop,
                  orderId: booking.orderId,
                  lineItemId: booking.groupKey,
                  slotKey: newSlotKey,
                  productId: booking.productId,
                  date: newTravelDate,
                  bookingMode: booking.bookingMode,
                  poolKey: booking.poolKey,
                  guideUnitsRequired: booking.guideUnitsRequired,
                  groupKey: booking.groupKey,
                }),
              );
            }
          }
        });
      },
    );
  } catch (error) {
    if (error instanceof BookingCapacityConflict) {
      return {
        ok: false,
        code: "ELIGIBILITY_CONFLICT",
        message: "선택한 날짜의 예약 가능 수량이 변경되었습니다. 다른 날짜를 선택해 주세요.",
        field: "newTravelDate",
      };
    }
    console.error(
      JSON.stringify({
        message: "Reschedule failed",
        shop,
        bookingId,
        oldDate: oldTravelDate,
        newDate: newTravelDate,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      ok: false,
      code: "INTERNAL_ERROR",
      message: "일정 변경 처리 중 오류가 발생했습니다.",
    };
  }

  let warningMessage: string | undefined;
  try {
    if (booking.orderId) {
      const admin = await getAdminApiClient(shop);
      if (admin) {
        const metaResult = await upsertOrderTravelDateMetafield({
          admin,
          orderId: booking.orderId,
          travelDate: newTravelDate,
        });
        if (!metaResult.ok) {
          warningMessage =
            "주문 메타데이터 동기화에 실패했습니다. 주문 화면에는 이전 날짜가 보일 수 있습니다.";
          console.warn(
            JSON.stringify({
              message: "Order travel_date sync failed",
              shop,
              bookingId,
              orderId: booking.orderId,
              travelDate: newTravelDate,
              error: metaResult.message,
            }),
          );
        }
      } else {
        warningMessage =
          "주문 메타데이터 동기화를 건너뛰었습니다. 주문 화면에는 이전 날짜가 보일 수 있습니다.";
        console.warn(
          JSON.stringify({
            message: "Order travel_date sync skipped (admin unavailable)",
            shop,
            bookingId,
            orderId: booking.orderId,
            travelDate: newTravelDate,
          }),
        );
      }
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        message: "Order travel_date sync error",
        shop,
        bookingId,
        orderId: booking.orderId,
        travelDate: newTravelDate,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  console.log(
    JSON.stringify({
      message: "Reschedule success",
      shop,
      bookingId,
      oldDate: oldTravelDate,
      newDate: newTravelDate,
    }),
  );

  return { ok: true, ...(warningMessage ? { warningMessage } : {}) };
}
