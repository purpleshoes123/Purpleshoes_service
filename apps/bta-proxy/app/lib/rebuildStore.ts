/**
 * Rebuild Store - Redis confirmed ledger 저장
 * Phase 5-6R: Redis에 confirmed booking을 영속적으로 저장하기 위한 키 구조 정의
 */

/**
 * Confirmed booking record 구조
 */
export interface ConfirmedBookingRecord {
  bookingId: string;
  shop: string;
  productId: string;
  productTitle?: string;
  travelDate: string; // YYYY-MM-DD
  bookingMode: "private" | "shared";
  poolKey: string;
  guideUnitsRequired: number;
  travelers?: {
    adult: number;
    child: number;
    infant: number;
  };
  status: "confirmed";
  orderId: string;
  groupKey: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Redis 키 생성 헬퍼
 */
export class RebuildStoreKeys {
  /**
   * Confirmed booking record 키
   * booking:confirmed:{shop}:{bookingId}
   */
  static confirmedBooking(shop: string, bookingId: string): string {
    return `booking:confirmed:${shop}:${bookingId}`;
  }

  /**
   * Date index 키
   * booking:date:{shop}:{travelDate}
   */
  static dateIndex(shop: string, travelDate: string): string {
    return `booking:date:${shop}:${travelDate}`;
  }

  /**
   * Slot index 키
   * booking:slot:{shop}:{slotKey}
   */
  static slotIndex(shop: string, slotKey: string): string {
    return `booking:slot:${shop}:${slotKey}`;
  }

  /**
   * Pool index 키
   * booking:pool:{shop}:{poolDayKey}
   */
  static poolIndex(shop: string, poolDayKey: string): string {
    return `booking:pool:${shop}:${poolDayKey}`;
  }

  /**
   * Order line index 키
   * booking:idx:orderline:{shop}:{orderId}:{lineItemId}
   */
  static orderLineIndex(shop: string, orderId: string, lineItemId: string): string {
    return `booking:idx:orderline:${shop}:${orderId}:${lineItemId}`;
  }

  /**
   * Order index 키
   * booking:idx:order:{shop}:{orderId}
   */
  static orderIndex(shop: string, orderId: string): string {
    return `booking:idx:order:${shop}:${orderId}`;
  }

  /**
   * Group index 키
   * booking:idx:group:{shop}:{groupKey}
   */
  static groupIndex(shop: string, groupKey: string): string {
    return `booking:idx:group:${shop}:${groupKey}`;
  }

  /**
   * Rebuild 락 키
   * lock:rebuild:{shop}
   */
  static rebuildLock(shop: string): string {
    return `lock:rebuild:${shop}`;
  }
}
