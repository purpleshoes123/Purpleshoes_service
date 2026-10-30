/**
 * Booking Store 추상화
 * SSOT 9장: Store timeout, retries, Hold TTL
 * SSOT 10장: BOOKING_STORE_TYPE (redis|postgres|memory)
 */

import { createRequire } from "module";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import db from "~/db.server.ts";
import { maskPII } from "~/lib/masking";
import { makeSlotKey } from "~/domains/bookings/bookingKeys";
import {
  confirmRedisBookingCapacity,
  type ConfirmationCapacity,
} from "~/domains/bookings/redisBookingCapacity";
import { mutateRedisBookingCapacity } from "~/domains/bookings/redisBookingCapacityMutation";
import { releaseRedisBookingHold } from "~/domains/bookings/redisBookingHoldRelease";
import { createRedisBookingHold } from "~/domains/bookings/redisBookingHoldCreate";

const require = createRequire(import.meta.url);

/**
 * 고객 정보 타입
 */
export interface Customer {
  name: string;
  phone?: string;
  email?: string;
}

/**
 * Availability 결과
 */
export interface AvailabilityResult {
  available: boolean;
  remaining: number;
  cutoffMinutes: number;
  message: string | null;
}

/**
 * Hold 결과
 */
export interface HoldResult {
  holdId: string;
  expiresAt: string; // ISO 8601
}

/**
 * Hold 저장 데이터
 * Phase 5-5: poolDayKey, units, idempotencyKey, orderDraftKey 추가
 */
interface HoldData {
  holdId: string;
  slotKey: string;
  poolDayKey?: string; // pool 모드일 때
  pax: number;
  units: number; // guideUnitsRequired (pool 모드에서 사용)
  customer: Customer;
  expiresAt: string;
  createdAt: string;
  idempotencyKey?: string; // clientRequestId
  orderDraftKey?: string; // Shopify draft order ID (선택)
}

/**
 * Hold 인터페이스 (조회용)
 */
export interface Hold {
  holdId: string;
  slotKey: string;
  poolDayKey?: string;
  units: number;
  expiresAt: string;
  idempotencyKey?: string;
  orderDraftKey?: string;
  createdAt: string;
}

/**
 * Booking Store 인터페이스
 * Phase 5-3: confirmed bookings 및 pool 사용량 조회 메서드 추가
 */
export interface BookingStore {
  getAvailability(slotKey: string, pax: number): Promise<AvailabilityResult>;
  createHold(
    slotKey: string,
    pax: number,
    customer: Customer,
    clientRequestId?: string,
    options?: {
      poolDayKey?: string;
      units?: number;
      orderDraftKey?: string;
      bookingMode?: "private" | "shared";
      poolKey?: string;
      date?: string;
      capacityUnits?: number;
    },
  ): Promise<HoldResult>;
  getHoldByIdempotencyKey(clientRequestId: string): Promise<HoldResult | null>;
  // Phase 5-3: confirmed bookings 및 pool 사용량 조회
  hasConfirmedBooking(slotKey: string, shop?: string): Promise<boolean>;
  getPoolUsedUnits(params: { poolKey: string; date: string }): Promise<number>;
  // Phase 5-4: confirmed 예약 upsert/취소
  // Phase 5-7: groupKey 추가 (그룹 기반 멱등성 보장)
  upsertConfirmedBooking(
    params: {
      shop: string;
      orderId: string;
      lineItemId: string;
      slotKey: string;
      productId: string;
      date: string;
      bookingMode: string;
      poolKey: string;
      guideUnitsRequired: number;
      groupKey?: string; // Phase 5-7: 그룹 키 (그룹 단위 멱등성)
    },
    capacity?: ConfirmationCapacity,
  ): Promise<void>;
  removeConfirmedBooking(params: {
    shop: string;
    orderId: string;
    lineItemId: string;
  }): Promise<void>;
  // Phase 5-7: 그룹 기반 confirmed 해제
  removeConfirmedBookingByGroupKey(
    groupKey: string,
    scope?: { shop: string; orderId: string },
  ): Promise<void>;
  // Phase 5-5: Hold 관리 메서드
  getActiveHoldsBySlot(slotKey: string): Promise<Hold[]>;
  getActiveHoldsByPool(poolDayKey: string): Promise<Hold[]>;
  releaseHold(holdId: string): Promise<void>;
  commitHoldToConfirmed(holdId: string, orderId: string, lineItemId: string): Promise<void>;
}

/**
 * 재시도 가능한 에러인지 확인
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // 네트워크 에러
    if (
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("ENOTFOUND")
    ) {
      return true;
    }
    // 타임아웃
    if (error.message.includes("timeout") || error.name === "TimeoutError") {
      return true;
    }
  }
  // 5xx 에러는 store 구현에서 처리
  return false;
}

/**
 * 지수 백오프로 대기
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 타임아웃 래퍼
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  correlationId: string,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Store operation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    console.warn(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Store operation timeout",
          timeoutMs,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    throw error;
  }
}

/**
 * 재시도 로직이 포함된 래퍼
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  correlationId: string,
  timeoutMs: number,
  maxRetries: number = 1,
): Promise<T> {
  const baseBackoff = 200; // 200ms
  const maxBackoff = 500; // 500ms

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(operation(), timeoutMs, correlationId);
    } catch (error) {
      const isRetryable = isRetryableError(error);
      const shouldRetry = isRetryable && attempt < maxRetries;

      if (shouldRetry) {
        const backoff = Math.min(baseBackoff * Math.pow(2, attempt), maxBackoff);
        console.warn(
          JSON.stringify(
            maskPII({
              correlationId,
              message: "Store operation failed, retrying",
              attempt,
              backoffMs: backoff,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
        await sleep(backoff);
        continue;
      }

      // 재시도 불가능한 경우 에러 throw
      throw error;
    }
  }

  throw new Error("Unreachable");
}

/**
 * In-memory Booking Store (개발용)
 * Phase 5-3: confirmed bookings 및 pool 사용량 추적 추가
 */
export class MemoryBookingStore implements BookingStore {
  private slots = new Map<string, { capacity: number; remaining: number }>();
  private holds = new Map<string, HoldData>();
  private idempotencyMap = new Map<string, string>(); // clientRequestId -> holdId
  // Phase 5-3: confirmed bookings 추적 (slotKey -> confirmed 여부)
  private confirmedBookings = new Map<string, boolean>();
  // Phase 5-3: pool 사용량 추적 (poolKey|date -> usedUnits)
  private poolUsage = new Map<string, number>(); // poolKey|date -> usedUnits
  // Phase 5-4: confirmed 예약 상세 정보 (멱등성 보장용)
  private confirmedBookingDetails = new Map<
    string,
    {
      shop: string;
      orderId: string;
      lineItemId: string;
      slotKey: string;
      productId: string;
      date: string;
      bookingMode: string;
      poolKey: string;
      guideUnitsRequired: number;
    }
  >(); // shop|orderId|lineItemId -> booking details

  async getAvailability(slotKey: string, pax: number): Promise<AvailabilityResult> {
    // 기본값: 항상 사용 가능, 무제한
    const slot = this.slots.get(slotKey);
    if (!slot) {
      // 슬롯이 없으면 기본값으로 생성 (무제한)
      this.slots.set(slotKey, { capacity: 999, remaining: 999 });
      return {
        available: true,
        remaining: 999,
        cutoffMinutes: 1440, // 24시간
        message: null,
      };
    }

    const available = slot.remaining >= pax;
    return {
      available,
      remaining: slot.remaining,
      cutoffMinutes: 1440,
      message: available ? null : "예약 가능한 좌석이 부족합니다.",
    };
  }

  async createHold(
    slotKey: string,
    pax: number,
    customer: Customer,
    clientRequestId?: string,
    options?: {
      poolDayKey?: string;
      units?: number;
      orderDraftKey?: string;
      bookingMode?: "private" | "shared";
      poolKey?: string;
      date?: string;
      capacityUnits?: number;
    },
  ): Promise<HoldResult> {
    // Phase 5-5: 원자적 락 획득 (단일 프로세스에서는 JavaScript 단일 스레드 특성 활용)
    // Private 모드: slotKey에 대해 active hold 존재 여부 체크
    if (options?.bookingMode === "private") {
      const activeHolds = await this.getActiveHoldsBySlot(slotKey);
      if (activeHolds.length > 0) {
        throw new Error("BOOKING_NOT_AVAILABLE");
      }
    }

    // Pool 모드: poolDayKey에 대해 capacity 체크
    if (options?.bookingMode === "shared" && options?.poolDayKey) {
      const confirmedUnits = await this.getPoolUsedUnits({
        poolKey: options.poolKey || "DEFAULT",
        date: options.date || "",
      });
      const activeHolds = await this.getActiveHoldsByPool(options.poolDayKey);
      const activeHoldUnits = activeHolds.reduce((sum, h) => sum + h.units, 0);
      const requestUnits = options.units || 1;
      const capacityUnits = options.capacityUnits || 1;

      if (confirmedUnits + activeHoldUnits + requestUnits > capacityUnits) {
        throw new Error("BOOKING_NOT_AVAILABLE");
      }
    }

    // Idempotency 체크
    if (clientRequestId) {
      const existingHoldId = this.idempotencyMap.get(clientRequestId);
      if (existingHoldId) {
        const existingHold = this.holds.get(existingHoldId);
        if (existingHold && new Date(existingHold.expiresAt) > new Date()) {
          return {
            holdId: existingHold.holdId,
            expiresAt: existingHold.expiresAt,
          };
        }
      }
    }

    // Hold 생성
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = new Date();
    const holdTTL = Number(process.env.HOLD_TTL_SEC) || 600; // 기본 600초
    const expiresAt = new Date(now.getTime() + holdTTL * 1000);

    const holdData: HoldData = {
      holdId,
      slotKey,
      poolDayKey: options?.poolDayKey,
      pax,
      units: options?.units || 1,
      customer,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
      idempotencyKey: clientRequestId,
      orderDraftKey: options?.orderDraftKey,
    };

    this.holds.set(holdId, holdData);

    // Idempotency 매핑 저장
    if (clientRequestId) {
      this.idempotencyMap.set(clientRequestId, holdId);
    }

    // 슬롯 업데이트 (remaining 감소) - 기존 로직 유지
    const slot = this.slots.get(slotKey);
    if (slot) {
      slot.remaining = Math.max(0, slot.remaining - pax);
    } else {
      // 슬롯이 없으면 생성 (기본 capacity 20)
      this.slots.set(slotKey, { capacity: 20, remaining: 20 - pax });
    }

    return {
      holdId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async getHoldByIdempotencyKey(clientRequestId: string): Promise<HoldResult | null> {
    const holdId = this.idempotencyMap.get(clientRequestId);
    if (!holdId) {
      return null;
    }

    const hold = this.holds.get(holdId);
    if (!hold) {
      return null;
    }

    // 만료 체크
    const expiresAt = new Date(hold.expiresAt);
    if (Date.now() > expiresAt.getTime()) {
      // 만료된 hold 제거
      this.holds.delete(holdId);
      this.idempotencyMap.delete(clientRequestId);
      return null;
    }

    return {
      holdId: hold.holdId,
      expiresAt: hold.expiresAt,
    };
  }

  /**
   * 만료된 hold 정리
   */
  cleanup(): void {
    const now = Date.now();
    for (const [holdId, hold] of this.holds.entries()) {
      const expiresAt = new Date(hold.expiresAt).getTime();
      if (now > expiresAt) {
        this.holds.delete(holdId);
        // idempotency 매핑도 제거
        for (const [key, value] of this.idempotencyMap.entries()) {
          if (value === holdId) {
            this.idempotencyMap.delete(key);
          }
        }
      }
    }
  }

  // Phase 5-3: confirmed booking 확인
  async hasConfirmedBooking(slotKey: string, shop?: string): Promise<boolean> {
    const confirmed = this.confirmedBookings.get(slotKey) === true;
    if (!confirmed) {
      return false;
    }

    // 본문이 없으면 orphan으로 간주하고 정리
    let hasDetails = false;
    for (const details of this.confirmedBookingDetails.values()) {
      if (details.slotKey === slotKey) {
        hasDetails = true;
        break;
      }
    }

    if (!hasDetails) {
      this.confirmedBookings.delete(slotKey);
      return false;
    }

    return true;
  }

  // Phase 5-3: pool 사용량 조회
  async getPoolUsedUnits(params: { poolKey: string; date: string }): Promise<number> {
    const key = `${params.poolKey}|${params.date}`;
    return this.poolUsage.get(key) || 0;
  }

  /**
   * 테스트용: confirmed booking 추가 (seed)
   * Phase 5-3에서 테스트용으로 사용
   */
  seedConfirmedBooking(slotKey: string): void {
    const [productId = "seed", date = "1970-01-01"] = slotKey.split("|");
    const key = `seed|${slotKey}|${Date.now()}`;
    this.confirmedBookingDetails.set(key, {
      shop: "seed",
      orderId: "seed",
      lineItemId: key,
      slotKey,
      productId,
      date,
      bookingMode: "private",
      poolKey: "DEFAULT",
      guideUnitsRequired: 1,
    });
    this.confirmedBookings.set(slotKey, true);
  }

  /**
   * 테스트용: confirmed index만 추가 (orphan)
   */
  seedConfirmedBookingOrphan(slotKey: string): void {
    this.confirmedBookings.set(slotKey, true);
  }

  /**
   * 테스트용: pool 사용량 추가 (seed)
   * Phase 5-3에서 테스트용으로 사용
   */
  seedPoolUsage(poolKey: string, date: string, usedUnits: number): void {
    const key = `${poolKey}|${date}`;
    this.poolUsage.set(key, usedUnits);
  }

  // Phase 5-4: confirmed 예약 upsert (멱등)
  // Phase 5-7: groupKey 기반 멱등성 지원
  async upsertConfirmedBooking(params: {
    shop: string;
    orderId: string;
    lineItemId: string;
    slotKey: string;
    productId: string;
    date: string;
    bookingMode: string;
    poolKey: string;
    guideUnitsRequired: number;
    groupKey?: string; // Phase 5-7: 그룹 키
  }): Promise<void> {
    // Phase 5-7: groupKey가 있으면 그룹 기반 멱등성 사용
    if (params.groupKey) {
      // 그룹 키 기반 멱등성: shop|orderId|groupKey
      const groupIdempotencyKey = `${params.shop}|${params.orderId}|${params.groupKey}`;

      // 이미 그룹이 처리되었으면 no-op (그룹당 1회만 처리)
      if (this.confirmedBookingDetails.has(groupIdempotencyKey)) {
        return;
      }

      // 그룹 기반 confirmed booking 저장
      this.confirmedBookingDetails.set(groupIdempotencyKey, {
        ...params,
        lineItemId: groupIdempotencyKey, // 그룹 키를 lineItemId로 사용
      });
    } else {
      // 기존 방식: lineItemId 기반 멱등성
      const idempotencyKey = `${params.shop}|${params.orderId}|${params.lineItemId}`;

      // 이미 존재하면 no-op (멱등성 보장)
      if (this.confirmedBookingDetails.has(idempotencyKey)) {
        return;
      }

      // confirmed booking 상세 정보 저장
      this.confirmedBookingDetails.set(idempotencyKey, params);
    }

    // slotKey에 confirmed 마킹
    this.confirmedBookings.set(params.slotKey, true);

    // pool 사용량 업데이트
    const poolKey = `${params.poolKey}|${params.date}`;
    const currentUsage = this.poolUsage.get(poolKey) || 0;
    this.poolUsage.set(poolKey, currentUsage + params.guideUnitsRequired);
  }

  // Phase 5-4: confirmed 예약 제거 (취소/환불)
  async removeConfirmedBooking(params: {
    shop: string;
    orderId: string;
    lineItemId: string;
  }): Promise<void> {
    // 멱등성 키로 찾기
    const idempotencyKey = `${params.shop}|${params.orderId}|${params.lineItemId}`;
    const booking = this.confirmedBookingDetails.get(idempotencyKey);

    if (!booking) {
      // 이미 제거되었거나 존재하지 않으면 no-op
      return;
    }

    // confirmed booking 상세 정보 제거
    this.confirmedBookingDetails.delete(idempotencyKey);

    // slotKey의 confirmed 마킹 제거 (다른 confirmed가 없으면)
    // 같은 slotKey를 가진 다른 confirmed가 있는지 확인
    let hasOtherConfirmed = false;
    for (const [key, details] of this.confirmedBookingDetails.entries()) {
      if (details.slotKey === booking.slotKey && key !== idempotencyKey) {
        hasOtherConfirmed = true;
        break;
      }
    }
    if (!hasOtherConfirmed) {
      this.confirmedBookings.delete(booking.slotKey);
    }

    // pool 사용량 감소
    const poolKey = `${booking.poolKey}|${booking.date}`;
    const currentUsage = this.poolUsage.get(poolKey) || 0;
    this.poolUsage.set(poolKey, Math.max(0, currentUsage - booking.guideUnitsRequired));
  }

  // Phase 5-7: 그룹 기반 confirmed 해제
  async removeConfirmedBookingByGroupKey(groupKey: string): Promise<void> {
    // groupKey를 포함하는 모든 confirmed booking 찾기
    const keysToRemove: string[] = [];
    const bookingsToRemove: Array<{
      slotKey: string;
      poolKey: string;
      date: string;
      guideUnitsRequired: number;
    }> = [];

    for (const [key, details] of this.confirmedBookingDetails.entries()) {
      // groupKey가 저장된 booking 찾기 (groupKey가 idempotencyKey에 포함되어 있거나 별도 필드로 저장)
      // groupKey 형식: travel_date|productId|poolKey|holdId
      // idempotencyKey 형식: shop|orderId|groupKey 또는 shop|orderId|lineItemId
      if (key.includes(groupKey) || (details as any).groupKey === groupKey) {
        keysToRemove.push(key);
        bookingsToRemove.push({
          slotKey: details.slotKey,
          poolKey: details.poolKey,
          date: details.date,
          guideUnitsRequired: details.guideUnitsRequired,
        });
      }
    }

    // 찾은 booking들 제거
    for (const key of keysToRemove) {
      this.confirmedBookingDetails.delete(key);
    }

    // slotKey의 confirmed 마킹 제거 (다른 confirmed가 없으면)
    for (const booking of bookingsToRemove) {
      let hasOtherConfirmed = false;
      for (const [key, details] of this.confirmedBookingDetails.entries()) {
        if (details.slotKey === booking.slotKey) {
          hasOtherConfirmed = true;
          break;
        }
      }
      if (!hasOtherConfirmed) {
        this.confirmedBookings.delete(booking.slotKey);
      }

      // pool 사용량 감소
      const poolKey = `${booking.poolKey}|${booking.date}`;
      const currentUsage = this.poolUsage.get(poolKey) || 0;
      this.poolUsage.set(poolKey, Math.max(0, currentUsage - booking.guideUnitsRequired));
    }
  }

  // Phase 5-5: Active holds 조회
  async getActiveHoldsBySlot(slotKey: string): Promise<Hold[]> {
    const now = new Date();
    const activeHolds: Hold[] = [];

    for (const [, holdData] of this.holds.entries()) {
      if (holdData.slotKey === slotKey && new Date(holdData.expiresAt) > now) {
        activeHolds.push({
          holdId: holdData.holdId,
          slotKey: holdData.slotKey,
          poolDayKey: holdData.poolDayKey,
          units: holdData.units || 1,
          expiresAt: holdData.expiresAt,
          idempotencyKey: holdData.idempotencyKey,
          orderDraftKey: holdData.orderDraftKey,
          createdAt: holdData.createdAt,
        });
      }
    }

    return activeHolds;
  }

  async getActiveHoldsByPool(poolDayKey: string): Promise<Hold[]> {
    const now = new Date();
    const activeHolds: Hold[] = [];

    for (const [, holdData] of this.holds.entries()) {
      if (holdData.poolDayKey === poolDayKey && new Date(holdData.expiresAt) > now) {
        activeHolds.push({
          holdId: holdData.holdId,
          slotKey: holdData.slotKey,
          poolDayKey: holdData.poolDayKey,
          units: holdData.units || 1,
          expiresAt: holdData.expiresAt,
          idempotencyKey: holdData.idempotencyKey,
          orderDraftKey: holdData.orderDraftKey,
          createdAt: holdData.createdAt,
        });
      }
    }

    return activeHolds;
  }

  async releaseHold(holdId: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (!hold) {
      return; // 이미 해제되었거나 존재하지 않음
    }

    // hold 제거
    this.holds.delete(holdId);

    // idempotency 매핑 제거
    if (hold.idempotencyKey) {
      this.idempotencyMap.delete(hold.idempotencyKey);
    }

    // 슬롯 remaining 복구 (기존 로직 유지)
    const slot = this.slots.get(hold.slotKey);
    if (slot) {
      slot.remaining = Math.min(slot.capacity, slot.remaining + hold.pax);
    }
  }

  async commitHoldToConfirmed(holdId: string, orderId: string, lineItemId: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (!hold) {
      return; // hold가 없으면 no-op
    }

    // hold를 confirmed로 전환하는 로직은 webhook에서 직접 처리
    // 여기서는 hold를 해제만 함
    await this.releaseHold(holdId);
  }

  /**
   * 테스트용: 모든 데이터 초기화
   */
  reset(): void {
    this.slots.clear();
    this.holds.clear();
    this.idempotencyMap.clear();
    this.confirmedBookings.clear();
    this.poolUsage.clear();
    this.confirmedBookingDetails.clear();
  }
}

/**
 * Redis Booking Store
 */
export class RedisBookingStore implements BookingStore {
  private client: any; // ioredis.Redis
  private timeoutMs: number;
  private static ledgerSlotCache = new Map<string, { slotKeys: Set<string>; updatedAt: number }>();
  private static readonly LEDGER_SLOT_CACHE_TTL_MS = 30_000;

  constructor(redisUrl: string, timeoutMs: number) {
    // ESM 환경에서 ioredis 로드 (createRequire 사용)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    this.client =
      process.env.DEPLOYMENT_MODE?.trim() === "multi-node"
        ? new Redis(redisUrl, {
            autoResendUnfulfilledCommands: false,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 0,
            commandTimeout: timeoutMs,
          })
        : new Redis(redisUrl);
    this.timeoutMs = timeoutMs;
  }

  // 내부 관리 API에서 Redis 직접 접근이 필요할 때 사용
  getRedisClient(): any {
    return this.client;
  }

  private async getLedgerSlotKeys(shop: string): Promise<Set<string>> {
    const cached = RedisBookingStore.ledgerSlotCache.get(shop);
    const now = Date.now();
    if (cached && now - cached.updatedAt < RedisBookingStore.LEDGER_SLOT_CACHE_TTL_MS) {
      return cached.slotKeys;
    }

    const slotKeys = new Set<string>();
    let cursor = "0";
    const pattern = `booking:confirmed:${shop}:*`;

    do {
      const result = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = result[0];
      const keys = result[1] as string[];

      for (const key of keys) {
        const bookingData = await this.client.get(key);
        if (!bookingData) {
          continue;
        }
        try {
          const booking = JSON.parse(bookingData) as {
            productId?: string;
            travelDate?: string;
            status?: string;
          };
          if (!booking.productId || !booking.travelDate) {
            continue;
          }
          if (booking.status && booking.status !== "confirmed") {
            continue;
          }
          slotKeys.add(makeSlotKey(booking.productId, booking.travelDate));
        } catch {
          // skip invalid payload
        }
      }
    } while (cursor !== "0");

    RedisBookingStore.ledgerSlotCache.set(shop, {
      slotKeys,
      updatedAt: now,
    });
    return slotKeys;
  }

  async getAvailability(slotKey: string, pax: number): Promise<AvailabilityResult> {
    const correlationId = randomUUID();
    return withRetry(
      async () => {
        const slotData = await this.client.get(`slot:${slotKey}`);
        if (!slotData) {
          // 슬롯이 없으면 기본값 (무제한)
          return {
            available: true,
            remaining: 999,
            cutoffMinutes: 1440,
            message: null,
          };
        }

        const slot = JSON.parse(slotData) as {
          capacity: number;
          remaining: number;
        };
        const available = slot.remaining >= pax;

        return {
          available,
          remaining: slot.remaining,
          cutoffMinutes: 1440,
          message: available ? null : "예약 가능한 좌석이 부족합니다.",
        };
      },
      correlationId,
      this.timeoutMs,
    );
  }

  async createHold(
    slotKey: string,
    pax: number,
    customer: Customer,
    clientRequestId?: string,
    options?: {
      poolDayKey?: string;
      units?: number;
      orderDraftKey?: string;
      bookingMode?: "private" | "shared";
      poolKey?: string;
      date?: string;
      capacityUnits?: number;
    },
  ): Promise<HoldResult> {
    const correlationId = randomUUID();
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      return createRedisBookingHold(this.client, slotKey, pax, customer, clientRequestId, options);
    }
    return withRetry(
      async () => {
        // Hold ID를 먼저 생성 (락과 hold 모두에서 동일한 ID 사용)
        const holdId = `hold_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const now = new Date();
        const holdTTL = Number(process.env.HOLD_TTL_SEC) || 600;
        const expiresAt = new Date(now.getTime() + holdTTL * 1000);

        // Phase 5-5: 원자적 락 획득
        // Private 모드: SET lock:slotKey holdId NX PX ttl
        if (options?.bookingMode === "private") {
          const lockKey = `lock:slot:${slotKey}`;

          // 원자적 락 획득 시도 (동일 holdId 사용)
          const lockResult = await this.client.set(lockKey, holdId, "PX", holdTTL * 1000, "NX");

          if (!lockResult) {
            // 락 획득 실패 (이미 active hold 존재)
            throw new Error("BOOKING_NOT_AVAILABLE");
          }
        }

        // Pool 모드: capacity 체크 (원자성은 확인 후 hold 생성으로 보장)
        if (options?.bookingMode === "shared" && options?.poolDayKey) {
          const confirmedUnits = await this.getPoolUsedUnits({
            poolKey: options.poolKey || "DEFAULT",
            date: options.date || "",
          });
          const activeHolds = await this.getActiveHoldsByPool(options.poolDayKey);
          const activeHoldUnits = activeHolds.reduce((sum, h) => sum + h.units, 0);
          const requestUnits = options.units || 1;
          const capacityUnits = options.capacityUnits || 1;

          if (confirmedUnits + activeHoldUnits + requestUnits > capacityUnits) {
            throw new Error("BOOKING_NOT_AVAILABLE");
          }
        }

        // Idempotency 체크
        if (clientRequestId) {
          const existingHoldId = await this.client.get(`idempo:${clientRequestId}`);
          if (existingHoldId) {
            const existingHoldData = await this.client.get(`hold:${existingHoldId}`);
            if (existingHoldData) {
              const hold = JSON.parse(existingHoldData) as HoldData;
              // 만료 체크
              if (new Date(hold.expiresAt) > new Date()) {
                return {
                  holdId: hold.holdId,
                  expiresAt: hold.expiresAt,
                };
              }
            }
          }
        }

        // Hold 생성 (위에서 생성한 holdId 재사용)

        const holdData: HoldData = {
          holdId,
          slotKey,
          poolDayKey: options?.poolDayKey,
          pax,
          units: options?.units || 1,
          customer,
          expiresAt: expiresAt.toISOString(),
          createdAt: now.toISOString(),
          idempotencyKey: clientRequestId,
          orderDraftKey: options?.orderDraftKey,
        };

        // Hold 저장 (TTL 적용)
        await this.client.setex(`hold:${holdId}`, holdTTL, JSON.stringify(holdData));

        // slotKey별 hold 인덱스 (조회용)
        if (options?.poolDayKey) {
          await this.client.sadd(`hold:pool:${options.poolDayKey}`, holdId);
          await this.client.expire(`hold:pool:${options.poolDayKey}`, holdTTL);
        }
        await this.client.sadd(`hold:slot:${slotKey}`, holdId);
        await this.client.expire(`hold:slot:${slotKey}`, holdTTL);

        // Idempotency 매핑 저장
        if (clientRequestId) {
          await this.client.setex(`idempo:${clientRequestId}`, holdTTL, holdId);
        }

        // 슬롯 업데이트
        const slotKeyRedis = `slot:${slotKey}`;
        const slotData = await this.client.get(slotKeyRedis);
        if (slotData) {
          const slot = JSON.parse(slotData) as {
            capacity: number;
            remaining: number;
          };
          slot.remaining = Math.max(0, slot.remaining - pax);
          await this.client.set(slotKeyRedis, JSON.stringify(slot));
        } else {
          // 슬롯이 없으면 생성
          await this.client.set(
            slotKeyRedis,
            JSON.stringify({ capacity: 20, remaining: 20 - pax }),
          );
        }

        return {
          holdId,
          expiresAt: expiresAt.toISOString(),
        };
      },
      correlationId,
      this.timeoutMs,
    );
  }

  async getHoldByIdempotencyKey(clientRequestId: string): Promise<HoldResult | null> {
    const correlationId = randomUUID();
    try {
      return await withRetry(
        async () => {
          const holdId = await this.client.get(`idempo:${clientRequestId}`);
          if (!holdId) {
            return null;
          }

          const holdData = await this.client.get(`hold:${holdId}`);
          if (!holdData) {
            return null;
          }

          const hold = JSON.parse(holdData) as HoldData;
          return {
            holdId: hold.holdId,
            expiresAt: hold.expiresAt,
          };
        },
        correlationId,
        this.timeoutMs,
      );
    } catch (error) {
      // 에러 발생 시 null 반환 (hold가 없거나 만료됨)
      return null;
    }
  }

  // Phase 5-3: confirmed booking 확인
  async hasConfirmedBooking(slotKey: string, shop?: string): Promise<boolean> {
    const correlationId = randomUUID();
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      // Only capacity transactions own flags. A read-side repair/delete can
      // race a confirmation or restore a flag after a completed cancellation.
      const flag = await withTimeout(
        this.client.get(`confirmed:${slotKey}`),
        this.timeoutMs,
        correlationId,
      );
      if (flag !== null && flag !== "1") {
        throw new Error("Booking slot requires reconciliation");
      }
      return flag === "1";
    }
    try {
      return await withRetry(
        async () => {
          const confirmed = await this.client.get(`confirmed:${slotKey}`);
          if (confirmed !== "1") {
            if (!shop) {
              return false;
            }

            const slotIndexKey = `booking:slot:${shop}:${slotKey}`;
            const slotCount = await this.client.scard(slotIndexKey);
            if (slotCount > 0) {
              await this.client.set(`confirmed:${slotKey}`, "1");
              return true;
            }

            const ledgerSlotKeys = await this.getLedgerSlotKeys(shop);
            if (ledgerSlotKeys.has(slotKey)) {
              await this.client.set(`confirmed:${slotKey}`, "1");
              return true;
            }

            return false;
          }

          if (shop) {
            const slotIndexKey = `booking:slot:${shop}:${slotKey}`;
            const slotCount = await this.client.scard(slotIndexKey);
            if (slotCount > 0) {
              return true;
            }
          }

          // 본문 확인 (orphan 인덱스 정리)
          let cursor = "0";
          const pattern = "confirmed:*|*|*";

          do {
            const result = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 200);
            cursor = result[0];
            const keys = result[1] as string[];

            for (const key of keys) {
              const bookingData = await this.client.get(key);
              if (!bookingData) {
                continue;
              }
              try {
                const booking = JSON.parse(bookingData) as { slotKey?: string };
                if (booking.slotKey === slotKey) {
                  return true;
                }
              } catch {
                // skip invalid payload
              }
            }
          } while (cursor !== "0");

          if (shop) {
            const ledgerSlotKeys = await this.getLedgerSlotKeys(shop);
            if (ledgerSlotKeys.has(slotKey)) {
              return true;
            }
          }

          await this.client.del(`confirmed:${slotKey}`);
          return false;
        },
        correlationId,
        this.timeoutMs,
      );
    } catch (error) {
      // 에러 발생 시 false 반환
      return false;
    }
  }

  // Phase 5-3: pool 사용량 조회
  async getPoolUsedUnits(params: { poolKey: string; date: string }): Promise<number> {
    const correlationId = randomUUID();
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      const raw = (await withTimeout(
        this.client.get(`pool:${params.poolKey}|${params.date}`),
        this.timeoutMs,
        correlationId,
      )) as string | null;
      if (raw === null) {
        return 0;
      }
      if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new Error("Booking pool requires reconciliation");
      }
      return Number(raw);
    }
    try {
      return await withRetry(
        async () => {
          const key = `pool:${params.poolKey}|${params.date}`;
          const usedUnits = await this.client.get(key);
          return usedUnits ? Number(usedUnits) : 0;
        },
        correlationId,
        this.timeoutMs,
      );
    } catch (error) {
      // 에러 발생 시 0 반환
      return 0;
    }
  }

  // Phase 5-4: confirmed 예약 upsert (멱등)
  async upsertConfirmedBooking(
    params: {
      shop: string;
      orderId: string;
      lineItemId: string;
      slotKey: string;
      productId: string;
      date: string;
      bookingMode: string;
      poolKey: string;
      guideUnitsRequired: number;
      groupKey?: string; // Phase 5-7: 그룹 키
    },
    capacity?: ConfirmationCapacity,
  ): Promise<void> {
    const correlationId = randomUUID();
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      await withTimeout(
        confirmRedisBookingCapacity(this.client, params, capacity),
        this.timeoutMs,
        correlationId,
      );
      return;
    }
    await withRetry(
      async () => {
        // Phase 5-7: groupKey가 있으면 그룹 기반 멱등성 사용
        let idempotencyKey: string;
        if (params.groupKey) {
          // 그룹 키 기반 멱등성: shop|orderId|groupKey
          idempotencyKey = `confirmed:${params.shop}|${params.orderId}|${params.groupKey}`;
        } else {
          // 기존 방식: lineItemId 기반 멱등성
          idempotencyKey = `confirmed:${params.shop}|${params.orderId}|${params.lineItemId}`;
        }

        // 이미 존재하면 no-op (멱등성 보장)
        const existing = await this.client.get(idempotencyKey);
        if (existing) {
          return;
        }

        // confirmed booking 상세 정보 저장 (groupKey 포함)
        await this.client.set(
          idempotencyKey,
          JSON.stringify({ ...params, groupKey: params.groupKey }),
        );

        // slotKey에 confirmed 마킹
        await this.client.set(`confirmed:${params.slotKey}`, "1");

        // pool 사용량 업데이트
        const poolKey = `pool:${params.poolKey}|${params.date}`;
        const currentUsage = await this.client.get(poolKey);
        const newUsage = (currentUsage ? Number(currentUsage) : 0) + params.guideUnitsRequired;
        await this.client.set(poolKey, String(newUsage));
      },
      correlationId,
      this.timeoutMs,
      process.env.DEPLOYMENT_MODE?.trim() === "multi-node" ? 0 : 1,
    );
  }

  // A group key can be shared by different orders. Multi-node callers must
  // identify the exact order; it must never become a Redis glob expression.
  async removeConfirmedBookingByGroupKey(
    groupKey: string,
    scope?: { shop: string; orderId: string },
  ): Promise<void> {
    const correlationId = randomUUID();
    const durable = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
    if (
      durable &&
      (!scope ||
        !scope.shop ||
        !scope.orderId ||
        !groupKey ||
        scope.shop.includes("|") ||
        scope.orderId.includes("|"))
    ) {
      throw new Error("Booking capacity removal requires exact order identity");
    }
    if (durable) {
      await mutateRedisBookingCapacity(this.client, { ...scope!, groupKey });
      return;
    }
    try {
      await withRetry(
        async () => {
          // groupKey를 포함하는 모든 confirmed booking 찾기
          // Redis keys 패턴: confirmed:shop|orderId|groupKey
          const pattern = `confirmed:*|*|${groupKey}`;
          const keys = await this.client.keys(pattern);

          for (const key of keys) {
            const bookingData = await this.client.get(key);
            if (!bookingData) {
              continue;
            }

            const booking = JSON.parse(bookingData) as {
              slotKey: string;
              poolKey: string;
              date: string;
              guideUnitsRequired: number;
            };

            // confirmed booking 제거
            await this.client.del(key);

            // slotKey의 confirmed 마킹 제거 (다른 confirmed가 없으면)
            const otherPattern = `confirmed:*|*|*`;
            const otherKeys = await this.client.keys(otherPattern);
            let hasOtherConfirmed = false;
            for (const otherKey of otherKeys) {
              if (otherKey !== key) {
                const otherBookingData = await this.client.get(otherKey);
                if (otherBookingData) {
                  const otherBooking = JSON.parse(otherBookingData) as {
                    slotKey: string;
                  };
                  if (otherBooking.slotKey === booking.slotKey) {
                    hasOtherConfirmed = true;
                    break;
                  }
                }
              }
            }
            if (!hasOtherConfirmed) {
              await this.client.del(`confirmed:${booking.slotKey}`);
            }

            // pool 사용량 감소
            const poolKey = `pool:${booking.poolKey}|${booking.date}`;
            const currentUsage = await this.client.get(poolKey);
            const newUsage = Math.max(
              0,
              (currentUsage ? Number(currentUsage) : 0) - booking.guideUnitsRequired,
            );
            await this.client.set(poolKey, String(newUsage));
          }
        },
        correlationId,
        this.timeoutMs,
        process.env.DEPLOYMENT_MODE?.trim() === "multi-node" ? 0 : 1,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Failed to remove confirmed booking by group key",
          groupKey: groupKey.substring(0, 50) + "...",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }

  // Phase 5-4: confirmed 예약 제거 (취소/환불)
  async removeConfirmedBooking(params: {
    shop: string;
    orderId: string;
    lineItemId: string;
  }): Promise<void> {
    const correlationId = randomUUID();
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      await mutateRedisBookingCapacity(this.client, {
        shop: params.shop,
        orderId: params.orderId,
        lineItemId: params.lineItemId,
      });
      return;
    }
    try {
      await withRetry(
        async () => {
          // 멱등성 키로 찾기
          const idempotencyKey = `confirmed:${params.shop}|${params.orderId}|${params.lineItemId}`;
          const bookingData = await this.client.get(idempotencyKey);

          if (!bookingData) {
            // 이미 제거되었거나 존재하지 않으면 no-op
            return;
          }

          const booking = JSON.parse(bookingData) as {
            slotKey: string;
            poolKey: string;
            date: string;
            guideUnitsRequired: number;
          };

          // confirmed booking 상세 정보 제거
          await this.client.del(idempotencyKey);

          // slotKey의 confirmed 마킹 제거 (다른 confirmed가 없으면)
          // 같은 slotKey를 가진 다른 confirmed가 있는지 확인
          const pattern = `confirmed:${params.shop}|*|*`;
          const keys = await this.client.keys(pattern);
          let hasOtherConfirmed = false;
          for (const key of keys) {
            if (key !== idempotencyKey) {
              const otherBookingData = await this.client.get(key);
              if (otherBookingData) {
                const otherBooking = JSON.parse(otherBookingData) as { slotKey: string };
                if (otherBooking.slotKey === booking.slotKey) {
                  hasOtherConfirmed = true;
                  break;
                }
              }
            }
          }
          if (!hasOtherConfirmed) {
            await this.client.del(`confirmed:${booking.slotKey}`);
          }

          // pool 사용량 감소
          const poolKey = `pool:${booking.poolKey}|${booking.date}`;
          const currentUsage = await this.client.get(poolKey);
          const newUsage = Math.max(
            0,
            (currentUsage ? Number(currentUsage) : 0) - booking.guideUnitsRequired,
          );
          await this.client.set(poolKey, String(newUsage));
        },
        correlationId,
        this.timeoutMs,
        process.env.DEPLOYMENT_MODE?.trim() === "multi-node" ? 0 : 1,
      );
    } catch (error) {
      if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
        throw new Error("Booking capacity removal requires reconciliation");
      }
      // 에러 발생 시 로깅만 하고 no-op (멱등성 보장)
      console.error(
        JSON.stringify({
          correlationId,
          message: "Failed to remove confirmed booking",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // Phase 5-5: Active holds 조회
  async getActiveHoldsBySlot(slotKey: string): Promise<Hold[]> {
    const correlationId = randomUUID();
    try {
      return await withRetry(
        async () => {
          const holdIds = await this.client.smembers(`hold:slot:${slotKey}`);
          const now = new Date();
          const activeHolds: Hold[] = [];

          for (const holdId of holdIds) {
            const holdData = await this.client.get(`hold:${holdId}`);
            if (!holdData) {
              continue; // 만료되었거나 삭제됨
            }

            const hold = JSON.parse(holdData) as HoldData;
            if (new Date(hold.expiresAt) > now) {
              activeHolds.push({
                holdId: hold.holdId,
                slotKey: hold.slotKey,
                poolDayKey: hold.poolDayKey,
                units: hold.units || 1,
                expiresAt: hold.expiresAt,
                idempotencyKey: hold.idempotencyKey,
                orderDraftKey: hold.orderDraftKey,
                createdAt: hold.createdAt,
              });
            }
          }

          return activeHolds;
        },
        correlationId,
        this.timeoutMs,
      );
    } catch (error) {
      // 에러 발생 시 빈 배열 반환
      return [];
    }
  }

  async getActiveHoldsByPool(poolDayKey: string): Promise<Hold[]> {
    const correlationId = randomUUID();
    try {
      return await withRetry(
        async () => {
          const holdIds = await this.client.smembers(`hold:pool:${poolDayKey}`);
          const now = new Date();
          const activeHolds: Hold[] = [];

          for (const holdId of holdIds) {
            const holdData = await this.client.get(`hold:${holdId}`);
            if (!holdData) {
              continue; // 만료되었거나 삭제됨
            }

            const hold = JSON.parse(holdData) as HoldData;
            if (new Date(hold.expiresAt) > now) {
              activeHolds.push({
                holdId: hold.holdId,
                slotKey: hold.slotKey,
                poolDayKey: hold.poolDayKey,
                units: hold.units || 1,
                expiresAt: hold.expiresAt,
                idempotencyKey: hold.idempotencyKey,
                orderDraftKey: hold.orderDraftKey,
                createdAt: hold.createdAt,
              });
            }
          }

          return activeHolds;
        },
        correlationId,
        this.timeoutMs,
      );
    } catch (error) {
      // 에러 발생 시 빈 배열 반환
      return [];
    }
  }

  async releaseHold(holdId: string): Promise<void> {
    const correlationId = randomUUID();
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      await releaseRedisBookingHold(this.client, holdId);
      return;
    }
    try {
      await withRetry(
        async () => {
          const holdData = await this.client.get(`hold:${holdId}`);
          if (!holdData) {
            return; // 이미 해제되었거나 존재하지 않음
          }

          const hold = JSON.parse(holdData) as HoldData;

          // hold 제거
          await this.client.del(`hold:${holdId}`);

          // 인덱스에서 제거
          if (hold.poolDayKey) {
            await this.client.srem(`hold:pool:${hold.poolDayKey}`, holdId);
          }
          await this.client.srem(`hold:slot:${hold.slotKey}`, holdId);

          // 락 해제 (private 모드)
          await this.client.del(`lock:slot:${hold.slotKey}`);

          // idempotency 매핑 제거
          if (hold.idempotencyKey) {
            await this.client.del(`idempo:${hold.idempotencyKey}`);
          }

          // 슬롯 remaining 복구
          const slotKeyRedis = `slot:${hold.slotKey}`;
          const slotData = await this.client.get(slotKeyRedis);
          if (slotData) {
            const slot = JSON.parse(slotData) as {
              capacity: number;
              remaining: number;
            };
            slot.remaining = Math.min(slot.capacity, slot.remaining + hold.pax);
            await this.client.set(slotKeyRedis, JSON.stringify(slot));
          }
        },
        correlationId,
        this.timeoutMs,
      );
    } catch (error) {
      // 에러 발생 시 로깅만 하고 no-op (멱등성 보장)
      console.error(
        JSON.stringify({
          correlationId,
          message: "Failed to release hold",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async commitHoldToConfirmed(holdId: string, orderId: string, lineItemId: string): Promise<void> {
    // hold를 confirmed로 전환하는 로직은 webhook에서 직접 처리
    // 여기서는 hold를 해제만 함
    await this.releaseHold(holdId);
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * PostgreSQL booking store.
 *
 * Redis is still useful for short-lived caches, but confirmed bookings and
 * checkout holds must survive an application restart.  PostgreSQL advisory
 * transaction locks serialize requests for the same private slot or shared
 * pool/day without requiring a second distributed lock implementation.
 */
export class PostgresBookingStore implements BookingStore {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  private async serialized<T>(
    lockKey: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(
      async (tx) => {
        // `hashtext` is evaluated inside the current transaction. The lock is
        // automatically released on commit or rollback.
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
        return operation(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private toHold(row: {
    holdId: string;
    slotKey: string;
    poolDayKey: string | null;
    units: number;
    expiresAt: Date;
    idempotencyKey: string | null;
    orderDraftKey: string | null;
    createdAt: Date;
  }): Hold {
    return {
      holdId: row.holdId,
      slotKey: row.slotKey,
      poolDayKey: row.poolDayKey ?? undefined,
      units: row.units,
      expiresAt: row.expiresAt.toISOString(),
      idempotencyKey: row.idempotencyKey ?? undefined,
      orderDraftKey: row.orderDraftKey ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getAvailability(slotKey: string, pax: number): Promise<AvailabilityResult> {
    const activeHoldPax = await db.bookingHold.aggregate({
      where: {
        slotKey,
        expiresAt: { gt: new Date() },
      },
      _sum: { pax: true },
    });
    // Preserve the established contract: an unseen slot is open-ended, while
    // a slot with active temporary holds starts from the legacy capacity of 20.
    const reservedPax = activeHoldPax._sum.pax ?? 0;
    const remaining = reservedPax === 0 ? 999 : Math.max(0, 20 - reservedPax);
    const available = remaining >= pax;
    return {
      available,
      remaining,
      cutoffMinutes: 1440,
      message: available ? null : "예약 가능한 좌석이 부족합니다.",
    };
  }

  async createHold(
    slotKey: string,
    pax: number,
    customer: Customer,
    clientRequestId?: string,
    options?: {
      poolDayKey?: string;
      units?: number;
      orderDraftKey?: string;
      bookingMode?: "private" | "shared";
      poolKey?: string;
      date?: string;
      capacityUnits?: number;
    },
  ): Promise<HoldResult> {
    const correlationId = randomUUID();
    return withRetry(
      async () => {
        const now = new Date();
        const holdTtlSeconds = Number(process.env.HOLD_TTL_SEC) || 600;
        const expiresAt = new Date(now.getTime() + holdTtlSeconds * 1000);
        const lockKey =
          options?.bookingMode === "shared"
            ? `booking:shared:${options.poolDayKey ?? options.poolKey ?? slotKey}`
            : `booking:private:${slotKey}`;

        return this.serialized(lockKey, async (tx) => {
          if (clientRequestId) {
            const existing = await tx.bookingHold.findUnique({
              where: { idempotencyKey: clientRequestId },
            });
            if (existing && existing.expiresAt > now) {
              return { holdId: existing.holdId, expiresAt: existing.expiresAt.toISOString() };
            }
            if (existing) {
              await tx.bookingHold.delete({ where: { holdId: existing.holdId } });
            }
          }

          if (options?.bookingMode === "private") {
            const activePrivateHold = await tx.bookingHold.findFirst({
              where: { slotKey, expiresAt: { gt: now } },
              select: { holdId: true },
            });
            if (activePrivateHold) {
              throw new Error("BOOKING_NOT_AVAILABLE");
            }
          }

          if (options?.bookingMode === "shared" && options.poolDayKey) {
            const [confirmed, holds] = await Promise.all([
              tx.confirmedBooking.aggregate({
                where: { poolKey: options.poolKey || "DEFAULT", date: options.date || "" },
                _sum: { guideUnitsRequired: true },
              }),
              tx.bookingHold.aggregate({
                where: { poolDayKey: options.poolDayKey, expiresAt: { gt: now } },
                _sum: { units: true },
              }),
            ]);
            const requestedUnits = options.units || 1;
            const capacityUnits = options.capacityUnits || 1;
            const usedUnits = (confirmed._sum.guideUnitsRequired || 0) + (holds._sum.units || 0);
            if (usedUnits + requestedUnits > capacityUnits) {
              throw new Error("BOOKING_NOT_AVAILABLE");
            }
          }

          const holdId = `hold_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          const created = await tx.bookingHold.create({
            data: {
              holdId,
              slotKey,
              poolDayKey: options?.poolDayKey,
              pax,
              units: options?.units || 1,
              customerName: customer.name,
              customerPhone: customer.phone,
              customerEmail: customer.email,
              expiresAt,
              createdAt: now,
              idempotencyKey: clientRequestId,
              orderDraftKey: options?.orderDraftKey,
            },
          });
          return { holdId: created.holdId, expiresAt: created.expiresAt.toISOString() };
        });
      },
      correlationId,
      this.timeoutMs,
    );
  }

  async getHoldByIdempotencyKey(clientRequestId: string): Promise<HoldResult | null> {
    const hold = await db.bookingHold.findUnique({
      where: { idempotencyKey: clientRequestId },
    });
    if (!hold || hold.expiresAt <= new Date()) {
      return null;
    }
    return { holdId: hold.holdId, expiresAt: hold.expiresAt.toISOString() };
  }

  // Phase 5-3: confirmed booking 확인
  async hasConfirmedBooking(slotKey: string, shop?: string): Promise<boolean> {
    return Boolean(
      await db.confirmedBooking.findFirst({
        where: { slotKey, ...(shop ? { shop } : {}) },
        select: { id: true },
      }),
    );
  }

  // Phase 5-3: pool 사용량 조회
  async getPoolUsedUnits(params: { poolKey: string; date: string }): Promise<number> {
    const result = await db.confirmedBooking.aggregate({
      where: { poolKey: params.poolKey, date: params.date },
      _sum: { guideUnitsRequired: true },
    });
    return result._sum.guideUnitsRequired || 0;
  }

  // Phase 5-4: confirmed 예약 upsert (멱등)
  async upsertConfirmedBooking(params: {
    shop: string;
    orderId: string;
    lineItemId: string;
    slotKey: string;
    productId: string;
    date: string;
    bookingMode: string;
    poolKey: string;
    guideUnitsRequired: number;
    groupKey?: string; // Phase 5-7: 그룹 키
  }): Promise<void> {
    const idempotencyKey = params.groupKey
      ? `confirmed:group:${params.shop}:${params.orderId}:${params.groupKey}`
      : `confirmed:line:${params.shop}:${params.orderId}:${params.lineItemId}`;
    await this.serialized(idempotencyKey, async (tx) => {
      const existing = await tx.confirmedBooking.findFirst({
        where: params.groupKey
          ? { shop: params.shop, orderId: params.orderId, groupKey: params.groupKey }
          : { shop: params.shop, orderId: params.orderId, lineItemId: params.lineItemId },
        select: { id: true },
      });
      if (existing) {
        return;
      }
      await tx.confirmedBooking.create({ data: params });
    });
  }

  // Phase 5-4: confirmed 예약 제거 (취소/환불)
  async removeConfirmedBooking(params: {
    shop: string;
    orderId: string;
    lineItemId: string;
  }): Promise<void> {
    await db.confirmedBooking.deleteMany({
      where: {
        shop: params.shop,
        orderId: params.orderId,
        lineItemId: params.lineItemId,
      },
    });
  }

  // Phase 5-7: 그룹 기반 confirmed 해제
  async removeConfirmedBookingByGroupKey(groupKey: string): Promise<void> {
    await db.confirmedBooking.deleteMany({ where: { groupKey } });
  }

  // Phase 5-5: Active holds 조회
  async getActiveHoldsBySlot(slotKey: string): Promise<Hold[]> {
    const holds = await db.bookingHold.findMany({
      where: { slotKey, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
    });
    return holds.map((hold) => this.toHold(hold));
  }

  async getActiveHoldsByPool(poolDayKey: string): Promise<Hold[]> {
    const holds = await db.bookingHold.findMany({
      where: { poolDayKey, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
    });
    return holds.map((hold) => this.toHold(hold));
  }

  async releaseHold(holdId: string): Promise<void> {
    await db.bookingHold.deleteMany({ where: { holdId } });
  }

  async commitHoldToConfirmed(holdId: string, orderId: string, lineItemId: string): Promise<void> {
    await this.releaseHold(holdId);
  }
}

/**
 * Booking Store 인스턴스
 */
let bookingStoreInstance: BookingStore | null = null;
let bookingStoreCleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Clears the singleton between isolated unit tests.
 * @internal
 */
export function resetBookingStoreForTests(): void {
  if (bookingStoreCleanupInterval) {
    clearInterval(bookingStoreCleanupInterval);
    bookingStoreCleanupInterval = null;
  }
  bookingStoreInstance = null;
}

/**
 * Booking Store 인스턴스를 가져옵니다.
 * SSOT 10장: BOOKING_STORE_TYPE (redis|postgres|memory, 기본: memory)
 */
export function getBookingStore(): BookingStore {
  const multiNode = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
  if (multiNode && (process.env.BOOKING_STORE_TYPE !== "redis" || !process.env.REDIS_URL)) {
    throw new Error("Multi-node bookings require shared Redis; memory fallback is disabled.");
  }
  if (bookingStoreInstance) {
    return bookingStoreInstance;
  }

  const storeType = process.env.BOOKING_STORE_TYPE || "memory";
  const timeoutMs = Number(process.env.STORE_TIMEOUT_MS) || 2000;

  if (storeType === "redis") {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      console.warn(
        JSON.stringify({
          message: "REDIS_URL not set, falling back to memory store",
        }),
      );
      bookingStoreInstance = new MemoryBookingStore();
    } else {
      try {
        bookingStoreInstance = new RedisBookingStore(redisUrl, timeoutMs);
        console.log(
          JSON.stringify({
            message: "Redis Booking Store initialized successfully",
            storeType: "redis",
          }),
        );
      } catch (error) {
        if (multiNode) {
          throw new Error(
            "Shared booking store initialization failed; memory fallback is disabled.",
          );
        }
        console.warn(
          JSON.stringify({
            message: "Redis connection failed, falling back to memory store",
          }),
        );
        bookingStoreInstance = new MemoryBookingStore();
      }
    }
  } else if (storeType === "postgres") {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "BOOKING_STORE_TYPE=postgres requires DATABASE_URL. Refusing to fall back to in-memory booking state.",
      );
    }
    bookingStoreInstance = new PostgresBookingStore(timeoutMs);
  } else {
    // memory (기본값)
    bookingStoreInstance = new MemoryBookingStore();
    // 주기적으로 만료된 항목 정리
    if (typeof setInterval !== "undefined") {
      bookingStoreCleanupInterval = setInterval(
        () => {
          (bookingStoreInstance as MemoryBookingStore).cleanup();
        },
        5 * 60 * 1000,
      ); // 5분마다
    }
  }

  return bookingStoreInstance;
}

/**
 * Redis 기반 Booking Store의 Redis client를 반환합니다.
 * 내부 Admin API에서 confirmed ledger 조회에 사용됩니다.
 */
export function getRedisBookingClient(): any | null {
  const store = getBookingStore();
  if (store instanceof RedisBookingStore) {
    return store.getRedisClient();
  }
  return null;
}
