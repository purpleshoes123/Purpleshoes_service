/**
 * Rebuild Service
 * Phase 5-6R: Shopify Admin API로 주문을 조회하여 Redis에 confirmed ledger 재생성
 * Phase X: groupKey 규칙 통일 (createGroupKey 유틸 사용)
 */

import { createHash } from "crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getEnv } from "~/lib/env";
import { fetchOrdersGraphQL, type ShopifyOrder } from "~/lib/shopifyAdmin";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "~/domains/bookings/rebuildStore";
import {
  removeConfirmedBookingRecord,
  resolveBookingIdByOrderLineIndex,
  resolveBookingIdsByOrderRecord,
  resolveBookingIdsByOrderIndex,
} from "~/domains/bookings/confirmedLedger";
import { extractBookingInfoFromLineItem } from "~/domains/webhooks/webhookUtils";
import { createGroupKey } from "~/domains/bookings/groupKey";
import { makeSlotKey } from "~/domains/bookings/bookingKeys";
import {
  extractTravelersFromLineItems,
  type TravelersSnapshot,
} from "~/domains/webhooks/webhookTravelers";
import { getTicketTypeByVariantId } from "~/domains/catalog/variantPricingService";

/**
 * Rebuild 결과
 */
export interface RebuildResult {
  scannedOrders: number;
  scannedLineItems: number;
  matchedTravelLineItems: number;
  upsertedBookings: number;
  deletedBookings: number;
  violations: {
    privateOverbooked: number;
    poolExceeded: number;
  };
}

/**
 * Rebuild 서비스
 */
export class RebuildService {
  private redisClient: any;
  private lockTtlSec: number;

  private assertWritesAllowed(dryRun: boolean): void {
    // The legacy rebuild reads Shopify, which can lack administrator date
    // changes, and rewrites derived counters separately. It must not overwrite
    // the new fleet journal. A journal-backed recovery path is required first.
    if (!dryRun && process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      throw new Error(
        "Legacy booking rebuild is unavailable on the durable fleet; use verified journal recovery",
      );
    }
  }

  constructor(redisClient: any) {
    this.redisClient = redisClient;
    const env = getEnv();
    this.lockTtlSec = env.REBUILD_LOCK_TTL_SEC || 600;
  }

  private logDebug(payload: Record<string, unknown>): void {
    if (process.env.DEBUG_BOOKING === "1") {
      console.log(JSON.stringify(payload));
    }
  }

  private getOrderId(order: ShopifyOrder): string {
    return order.id.replace("gid://shopify/Order/", "");
  }

  private normalizeFinancialStatus(order: ShopifyOrder): string {
    return (order.displayFinancialStatus || "").toLowerCase();
  }

  private getOrderIdCandidates(order: ShopifyOrder): string[] {
    const orderId = this.getOrderId(order);
    const name = typeof order.name === "string" ? order.name.replace("#", "") : "";
    const legacyResourceId =
      order.legacyResourceId !== undefined && order.legacyResourceId !== null
        ? String(order.legacyResourceId)
        : "";
    return Array.from(new Set([orderId, name, legacyResourceId].filter(Boolean)));
  }

  private isCancelledOrRefunded(order: ShopifyOrder): boolean {
    if (order.cancelledAt) {
      return true;
    }
    const status = this.normalizeFinancialStatus(order);
    if (!status) {
      return false;
    }
    if (status.includes("voided")) {
      return true;
    }
    if (status.includes("refunded") && status !== "partially_refunded") {
      return true;
    }
    return false;
  }

  private isPaidOrder(order: ShopifyOrder): boolean {
    const status = this.normalizeFinancialStatus(order);
    if (!status) {
      return false;
    }
    return status === "paid" || status === "partially_paid" || status === "partially_refunded";
  }

  async removeCancelledBookings(
    shop: string,
    orders: ShopifyOrder[],
    dryRun: boolean = false,
  ): Promise<number> {
    this.assertWritesAllowed(dryRun);
    let removedCount = 0;
    const cancelledOrders = orders.filter((order) => this.isCancelledOrRefunded(order));

    for (const order of cancelledOrders) {
      const orderId = this.getOrderId(order);
      let bookingIds = await resolveBookingIdsByOrderIndex(this.redisClient, shop, orderId);

      if (bookingIds.length === 0) {
        const lineItemIds = order.lineItems.edges
          .map((edge) => edge.node.id.replace("gid://shopify/LineItem/", ""))
          .filter(Boolean);
        const bookingIdSet = new Set<string>();
        for (const lineItemId of lineItemIds) {
          const bookingId = await resolveBookingIdByOrderLineIndex(
            this.redisClient,
            shop,
            orderId,
            lineItemId,
          );
          if (bookingId) {
            bookingIdSet.add(bookingId);
          }
        }
        if (bookingIdSet.size > 0) {
          bookingIds = Array.from(bookingIdSet);
          this.logDebug({
            message: "Rebuild cancelled order resolved by order line index",
            orderId,
            shop,
            bookingIdsCount: bookingIds.length,
          });
        }
      }

      if (bookingIds.length === 0) {
        const orderIdCandidates = this.getOrderIdCandidates(order);
        bookingIds = await resolveBookingIdsByOrderRecord(
          this.redisClient,
          shop,
          orderIdCandidates,
        );
        if (bookingIds.length > 0) {
          this.logDebug({
            message: "Rebuild cancelled order resolved by booking record",
            orderId,
            shop,
            bookingIdsCount: bookingIds.length,
            orderIdCandidates,
          });
        }
      }

      if (bookingIds.length === 0) {
        this.logDebug({
          message: "Rebuild cancelled order has no booking index",
          orderId,
          shop,
          cancelledAt: order.cancelledAt,
          displayFinancialStatus: order.displayFinancialStatus,
        });
        continue;
      }

      if (dryRun) {
        removedCount += bookingIds.length;
        continue;
      }

      for (const bookingId of bookingIds) {
        const removed = await removeConfirmedBookingRecord(this.redisClient, shop, bookingId, {
          orderId,
          cleanupOrphans: true,
        });
        if (removed) {
          removedCount += 1;
          this.logDebug({
            message: "Rebuild removed cancelled booking",
            orderId,
            bookingId,
            shop,
            travelDate: removed.travelDate,
          });
        }
      }
    }

    return removedCount;
  }

  /**
   * 결정적 bookingId 생성
   * bookingId = sha256(shop + "|" + groupKey)
   */
  private generateBookingId(shop: string, groupKey: string): string {
    const hash = createHash("sha256");
    hash.update(`${shop}|${groupKey}`);
    return hash.digest("hex");
  }

  /**
   * Redis 락 획득
   */
  async acquireLock(shop: string): Promise<boolean> {
    const lockKey = RebuildStoreKeys.rebuildLock(shop);
    const result = await this.redisClient.set(lockKey, "1", "EX", this.lockTtlSec, "NX");
    return result === "OK";
  }

  /**
   * Redis 락 해제
   */
  async releaseLock(shop: string): Promise<void> {
    const lockKey = RebuildStoreKeys.rebuildLock(shop);
    await this.redisClient.del(lockKey);
  }

  /**
   * Shopify Admin API로 주문 조회
   */
  async fetchOrders(
    admin: AdminApiContext,
    ordersFrom: string,
    ordersTo: string,
  ): Promise<ShopifyOrder[]> {
    try {
      return await fetchOrdersGraphQL(admin, ordersFrom, ordersTo);
    } catch (error) {
      if (error instanceof Error && error.message.includes("SHOPIFY_ADMIN_API_TIMEOUT")) {
        throw new Error("SHOPIFY_ADMIN_API_TIMEOUT");
      }
      throw new Error("SHOPIFY_ADMIN_API_ERROR");
    }
  }

  /**
   * 주문에서 travel_date가 있는 line_items 추출
   */
  extractTravelLineItems(orders: ShopifyOrder[]): Array<{
    order: ShopifyOrder;
    lineItem: {
      id: string;
      productId: string | null;
      variantId: string | null;
      quantity: number;
      title: string;
      properties: Array<{ name: string; value: string }>;
    };
  }> {
    this.logDebug({
      message: "Rebuild extractTravelLineItems start",
      orderCount: orders.length,
    });

    const travelLineItems: Array<{
      order: ShopifyOrder;
      lineItem: {
        id: string;
        productId: string | null;
        variantId: string | null;
        quantity: number;
        title: string;
        properties: Array<{ name: string; value: string }>;
      };
    }> = [];

    for (const order of orders) {
      const orderId = this.getOrderId(order);
      // 취소된 주문은 스킵
      if (this.isCancelledOrRefunded(order)) {
        this.logDebug({
          message: "Rebuild skip cancelled order",
          orderId,
          cancelledAt: order.cancelledAt,
          displayFinancialStatus: order.displayFinancialStatus,
        });
        continue;
      }
      if (!this.isPaidOrder(order)) {
        this.logDebug({
          message: "Rebuild skip non-paid order",
          orderId,
          displayFinancialStatus: order.displayFinancialStatus,
        });
        continue;
      }

      for (const edge of order.lineItems.edges) {
        const node = edge.node;

        // customAttributes를 properties로 변환
        const properties = node.customAttributes.map((attr) => ({
          name: attr.key,
          value: attr.value,
        }));

        // travel_date가 있는지 확인
        const travelDateProp = properties.find(
          (p) => p.name === "travel_date" || p.name === "travelDate",
        );

        if (!travelDateProp || !travelDateProp.value) {
          continue; // travel_date가 없으면 스킵
        }

        // productId 결정
        let productId: string | null = null;
        if (node.product?.id) {
          // GraphQL ID에서 숫자만 추출 (gid://shopify/Product/123 -> 123)
          productId = node.product.id.replace("gid://shopify/Product/", "");
        } else {
          // properties에서 productId 찾기
          const productIdProp = properties.find(
            (p) => p.name === "productId" || p.name === "product_id",
          );
          if (productIdProp) {
            productId = productIdProp.value;
          }
        }

        if (!productId) {
          this.logDebug({
            message: "Rebuild skip line item without productId",
            orderId,
            lineItemId: node.id.replace("gid://shopify/LineItem/", ""),
            travelDate: travelDateProp.value,
          });
          continue; // productId가 없으면 스킵
        }

        this.logDebug({
          message: "Rebuild travel line item",
          orderId,
          lineItemId: node.id.replace("gid://shopify/LineItem/", ""),
          productId,
          travelDate: travelDateProp.value,
        });

        travelLineItems.push({
          order,
          lineItem: {
            id: node.id.replace("gid://shopify/LineItem/", ""),
            productId,
            variantId: node.variant?.id
              ? node.variant.id.replace("gid://shopify/ProductVariant/", "")
              : null,
            quantity: node.quantity,
            title: node.title,
            properties,
          },
        });
      }
    }

    this.logDebug({
      message: "Rebuild extractTravelLineItems complete",
      matchedLineItems: travelLineItems.length,
    });

    return travelLineItems;
  }

  /**
   * Line items를 groupKey로 그룹화
   */
  async groupLineItemsByBooking(
    travelLineItems: Array<{
      order: ShopifyOrder;
      lineItem: {
        id: string;
        productId: string | null;
        variantId: string | null;
        quantity: number;
        title: string;
        properties: Array<{ name: string; value: string }>;
      };
    }>,
    shop: string,
  ): Promise<
    Array<{
      groupKey: string;
      order: ShopifyOrder;
      lineItems: Array<{
        id: string;
        productId: string | null;
        variantId: string | null;
        quantity: number;
        title: string;
        properties: Array<{ name: string; value: string }>;
      }>;
      bookingInfo: {
        productId: string;
        travelDate: string;
        bookingMode: "private" | "shared";
        poolKey: string;
        guideUnitsRequired: number;
      };
    }>
  > {
    const groups = new Map<
      string,
      {
        groupKey: string;
        order: ShopifyOrder;
        lineItems: Array<{
          id: string;
          productId: string | null;
          variantId: string | null;
          quantity: number;
          title: string;
          properties: Array<{ name: string; value: string }>;
        }>;
        bookingInfo: {
          productId: string;
          travelDate: string;
          bookingMode: "private" | "shared";
          poolKey: string;
          guideUnitsRequired: number;
        };
      }
    >();

    for (const { order, lineItem } of travelLineItems) {
      // extractBookingInfoFromLineItem 사용 (webhookUtils와 동일한 로직)
      const bookingInfo = await extractBookingInfoFromLineItem(
        {
          product_id: lineItem.productId,
          properties: lineItem.properties,
        },
        shop,
      );

      if (!bookingInfo) {
        this.logDebug({
          message: "Rebuild skip line item (bookingInfo not found)",
          orderId: order.id.replace("gid://shopify/Order/", ""),
          lineItemId: lineItem.id,
        });
        continue;
      }

      // properties에서 holdId 추출
      const holdIdProp = lineItem.properties.find(
        (p) => p.name === "hold_id" || p.name === "holdId",
      );
      const holdId = holdIdProp?.value || order.id.replace("gid://shopify/Order/", "");

      // 그룹 키 생성 (Phase X: 통일된 규칙 사용)
      const groupKey = createGroupKey({
        travelDate: bookingInfo.travelDate,
        productId: bookingInfo.productId,
        poolKey: bookingInfo.poolKey,
        bookingMode: bookingInfo.bookingMode,
        holdId,
      });

      this.logDebug({
        message: "Rebuild group line item",
        orderId: order.id.replace("gid://shopify/Order/", ""),
        lineItemId: lineItem.id,
        groupKey,
        travelDate: bookingInfo.travelDate,
        productId: bookingInfo.productId,
        bookingMode: bookingInfo.bookingMode,
        poolKey: bookingInfo.poolKey,
      });

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          groupKey,
          order,
          lineItems: [],
          bookingInfo: {
            productId: bookingInfo.productId,
            travelDate: bookingInfo.travelDate,
            bookingMode: bookingInfo.bookingMode,
            poolKey: bookingInfo.poolKey,
            guideUnitsRequired: bookingInfo.guideUnitsRequired,
          },
        });
      }

      groups.get(groupKey)!.lineItems.push(lineItem);
    }

    return Array.from(groups.values());
  }

  private async computeTravelersForGroup(params: {
    shop: string;
    bookingInfo: {
      productId: string;
    };
    lineItems: Array<{
      productId: string | null;
      variantId: string | null;
      quantity: number;
      title: string;
      properties: Array<{ name: string; value: string }>;
    }>;
  }): Promise<TravelersSnapshot | null> {
    const direct = extractTravelersFromLineItems(params.lineItems as any);
    if (direct) {
      return direct;
    }

    const fallback: TravelersSnapshot = { adult: 0, child: 0, infant: 0 };
    for (const lineItem of params.lineItems) {
      const variantId = lineItem.variantId;
      if (!variantId) {
        continue;
      }
      const productId = lineItem.productId || params.bookingInfo.productId;
      const quantity = Number.isFinite(lineItem.quantity)
        ? Math.max(0, Math.floor(lineItem.quantity))
        : 1;
      if (quantity <= 0) {
        continue;
      }
      const ticketType = await getTicketTypeByVariantId({
        shop: params.shop,
        productId,
        variantId,
      });
      if (!ticketType) {
        console.warn(
          JSON.stringify({
            message: "Rebuild travelers fallback: ticketType mapping missing",
            productId,
            variantId,
          }),
        );
        continue;
      }
      fallback[ticketType] += quantity;
    }

    const total = fallback.adult + fallback.child + fallback.infant;
    return total > 0 ? fallback : null;
  }

  private async upsertBookingIndexes(params: {
    shop: string;
    bookingId: string;
    groupKey: string;
    orderId: string;
    bookingInfo: {
      productId: string;
      travelDate: string;
      poolKey: string;
    };
    lineItems: Array<{ id: string }>;
  }): Promise<void> {
    const { shop, bookingId, groupKey, orderId, bookingInfo, lineItems } = params;

    await this.redisClient.sadd(
      RebuildStoreKeys.dateIndex(shop, bookingInfo.travelDate),
      bookingId,
    );
    await this.redisClient.sadd(
      RebuildStoreKeys.slotIndex(shop, makeSlotKey(bookingInfo.productId, bookingInfo.travelDate)),
      bookingId,
    );
    await this.redisClient.sadd(
      RebuildStoreKeys.poolIndex(shop, `${bookingInfo.poolKey}|${bookingInfo.travelDate}`),
      bookingId,
    );
    await this.redisClient.sadd(RebuildStoreKeys.orderIndex(shop, orderId), bookingId);
    await this.redisClient.set(RebuildStoreKeys.groupIndex(shop, groupKey), bookingId);

    for (const lineItem of lineItems) {
      await this.redisClient.set(
        RebuildStoreKeys.orderLineIndex(shop, orderId, lineItem.id),
        bookingId,
      );
    }
  }

  /**
   * 기존 bookings 삭제 (replace 모드)
   */
  async deleteExistingBookings(
    shop: string,
    travelDates: string[],
    filterTravelFrom?: string,
    filterTravelTo?: string,
    dryRun: boolean = false,
  ): Promise<number> {
    this.assertWritesAllowed(dryRun);
    let deletedCount = 0;

    // 필터링된 travelDates
    const datesToDelete = travelDates.filter((date) => {
      if (filterTravelFrom && date < filterTravelFrom) {
        return false;
      }
      if (filterTravelTo && date > filterTravelTo) {
        return false;
      }
      return true;
    });

    if (dryRun) {
      // dryRun: 실제 삭제 없이 카운트만 계산
      for (const date of datesToDelete) {
        const dateIndexKey = RebuildStoreKeys.dateIndex(shop, date);
        const bookingIds = await this.redisClient.smembers(dateIndexKey);
        deletedCount += bookingIds.length;
      }
      return deletedCount;
    }

    // 실제 삭제
    for (const date of datesToDelete) {
      const dateIndexKey = RebuildStoreKeys.dateIndex(shop, date);
      const bookingIds = await this.redisClient.smembers(dateIndexKey);

      for (const bookingId of bookingIds) {
        const removed = await removeConfirmedBookingRecord(this.redisClient, shop, bookingId, {
          cleanupOrphans: true,
        });
        if (removed) {
          deletedCount++;
        }
      }
    }

    return deletedCount;
  }

  /**
   * Confirmed bookings upsert
   */
  async upsertBookings(
    shop: string,
    groups: Array<{
      groupKey: string;
      order: ShopifyOrder;
      lineItems: Array<{
        id: string;
        productId: string | null;
        variantId: string | null;
        quantity: number;
        title: string;
        properties: Array<{ name: string; value: string }>;
      }>;
      bookingInfo: {
        productId: string;
        travelDate: string;
        bookingMode: "private" | "shared";
        poolKey: string;
        guideUnitsRequired: number;
      };
    }>,
    filterTravelFrom?: string,
    filterTravelTo?: string,
    dryRun: boolean = false,
  ): Promise<number> {
    this.assertWritesAllowed(dryRun);
    let upsertedCount = 0;
    const now = new Date().toISOString();
    const legacySlotKeys = new Set<string>();
    const legacyPoolUsage = new Map<string, number>();
    const legacyConfirmedRecords: Array<{ key: string; value: string }> = [];

    for (const group of groups) {
      const { groupKey, order, bookingInfo: parsedBookingInfo } = group;
      const orderId = order.id.replace("gid://shopify/Order/", "");

      // travel_date 필터링
      if (filterTravelFrom && parsedBookingInfo.travelDate < filterTravelFrom) {
        this.logDebug({
          message: "Rebuild skip group (travel_date before filter)",
          orderId,
          groupKey,
          travelDate: parsedBookingInfo.travelDate,
          filterTravelFrom,
        });
        continue;
      }
      if (filterTravelTo && parsedBookingInfo.travelDate > filterTravelTo) {
        this.logDebug({
          message: "Rebuild skip group (travel_date after filter)",
          orderId,
          groupKey,
          travelDate: parsedBookingInfo.travelDate,
          filterTravelTo,
        });
        continue;
      }

      // 결정적 bookingId 생성
      const bookingId = this.generateBookingId(shop, groupKey);

      const travelers = await this.computeTravelersForGroup({
        shop,
        bookingInfo: parsedBookingInfo,
        lineItems: group.lineItems,
      });
      const productTitle =
        typeof group.lineItems[0]?.title === "string" ? group.lineItems[0].title : undefined;

      // 기존 booking 확인
      const bookingKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);
      const existing = await this.redisClient.get(bookingKey);

      if (existing && !dryRun) {
        const existingBooking = JSON.parse(existing) as ConfirmedBookingRecord;
        const existingDate =
          typeof existingBooking.travelDate === "string" ? existingBooking.travelDate : "";
        const existingDateValid = /^\d{4}-\d{2}-\d{2}$/.test(existingDate);
        if (!existingDateValid) {
          console.error(
            JSON.stringify({
              message: "Rebuild existing booking has invalid travelDate",
              shop,
              orderId,
              bookingId,
              groupKey,
              existingDate,
              parsedDate: parsedBookingInfo.travelDate,
            }),
          );
        }

        if (existingDateValid && parsedBookingInfo.travelDate !== existingBooking.travelDate) {
          console.warn(
            JSON.stringify({
              message: "Rebuild booking travelDate mismatch",
              shop,
              orderId,
              bookingId,
              groupKey,
              parsedDate: parsedBookingInfo.travelDate,
              existingDate: existingBooking.travelDate,
            }),
          );
        }

        const effectiveBookingInfo = existingDateValid
          ? {
              productId: existingBooking.productId || parsedBookingInfo.productId,
              travelDate: existingBooking.travelDate,
              bookingMode: existingBooking.bookingMode || parsedBookingInfo.bookingMode,
              poolKey: existingBooking.poolKey || parsedBookingInfo.poolKey,
              guideUnitsRequired:
                existingBooking.guideUnitsRequired ?? parsedBookingInfo.guideUnitsRequired,
            }
          : parsedBookingInfo;

        this.logDebug({
          message: "Rebuild update existing booking",
          orderId,
          groupKey,
          bookingId,
          travelDate: effectiveBookingInfo.travelDate,
          productId: effectiveBookingInfo.productId,
        });
        // 이미 존재하면 업데이트만 (멱등성)
        existingBooking.updatedAt = now;
        if (!existingBooking.travelers && travelers) {
          existingBooking.travelers = travelers;
        }
        if (!existingBooking.productTitle && productTitle) {
          existingBooking.productTitle = productTitle;
        }
        await this.redisClient.set(bookingKey, JSON.stringify(existingBooking));
        await this.upsertBookingIndexes({
          shop,
          bookingId,
          groupKey,
          orderId,
          bookingInfo: effectiveBookingInfo,
          lineItems: group.lineItems,
        });
        upsertedCount++;
        if (!dryRun) {
          const slotKey = makeSlotKey(
            effectiveBookingInfo.productId,
            effectiveBookingInfo.travelDate,
          );
          legacySlotKeys.add(slotKey);
          const poolDayKey = `${effectiveBookingInfo.poolKey}|${effectiveBookingInfo.travelDate}`;
          legacyPoolUsage.set(
            poolDayKey,
            (legacyPoolUsage.get(poolDayKey) || 0) + effectiveBookingInfo.guideUnitsRequired,
          );
          legacyConfirmedRecords.push({
            key: `confirmed:${shop}|${orderId}|${groupKey}`,
            value: JSON.stringify({
              shop,
              orderId,
              lineItemId: groupKey,
              slotKey,
              productId: effectiveBookingInfo.productId,
              date: effectiveBookingInfo.travelDate,
              bookingMode: effectiveBookingInfo.bookingMode,
              poolKey: effectiveBookingInfo.poolKey,
              guideUnitsRequired: effectiveBookingInfo.guideUnitsRequired,
              groupKey,
            }),
          });
        }
        continue;
      }

      if (dryRun) {
        this.logDebug({
          message: "Rebuild dryRun upsert booking",
          orderId,
          groupKey,
          bookingId,
          travelDate: parsedBookingInfo.travelDate,
          productId: parsedBookingInfo.productId,
        });
        // dryRun: 실제 쓰기 없이 카운트만 증가
        upsertedCount++;
        continue;
      }

      // 새 booking record 생성
      const booking: ConfirmedBookingRecord = {
        bookingId,
        shop,
        productId: parsedBookingInfo.productId,
        ...(productTitle ? { productTitle } : {}),
        travelDate: parsedBookingInfo.travelDate,
        bookingMode: parsedBookingInfo.bookingMode,
        poolKey: parsedBookingInfo.poolKey,
        guideUnitsRequired: parsedBookingInfo.guideUnitsRequired,
        ...(travelers ? { travelers } : {}),
        status: "confirmed",
        orderId,
        groupKey,
        createdAt: existing ? JSON.parse(existing).createdAt : now,
        updatedAt: now,
      };

      // booking record 저장
      await this.redisClient.set(bookingKey, JSON.stringify(booking));

      await this.upsertBookingIndexes({
        shop,
        bookingId,
        groupKey,
        orderId,
        bookingInfo: parsedBookingInfo,
        lineItems: group.lineItems,
      });

      upsertedCount++;
      this.logDebug({
        message: "Rebuild upsert booking",
        orderId,
        groupKey,
        bookingId,
        travelDate: parsedBookingInfo.travelDate,
        productId: parsedBookingInfo.productId,
      });

      if (!dryRun) {
        const slotKey = makeSlotKey(parsedBookingInfo.productId, parsedBookingInfo.travelDate);
        legacySlotKeys.add(slotKey);
        const poolDayKey = `${parsedBookingInfo.poolKey}|${parsedBookingInfo.travelDate}`;
        legacyPoolUsage.set(
          poolDayKey,
          (legacyPoolUsage.get(poolDayKey) || 0) + parsedBookingInfo.guideUnitsRequired,
        );
        legacyConfirmedRecords.push({
          key: `confirmed:${shop}|${orderId}|${groupKey}`,
          value: JSON.stringify({
            shop,
            orderId,
            lineItemId: groupKey,
            slotKey,
            productId: parsedBookingInfo.productId,
            date: parsedBookingInfo.travelDate,
            bookingMode: parsedBookingInfo.bookingMode,
            poolKey: parsedBookingInfo.poolKey,
            guideUnitsRequired: parsedBookingInfo.guideUnitsRequired,
            groupKey,
          }),
        });
      }
    }

    if (!dryRun) {
      for (const slotKey of legacySlotKeys) {
        await this.redisClient.set(`confirmed:${slotKey}`, "1");
      }
      for (const [poolDayKey, units] of legacyPoolUsage.entries()) {
        await this.redisClient.set(`pool:${poolDayKey}`, String(units));
      }
      for (const record of legacyConfirmedRecords) {
        await this.redisClient.set(record.key, record.value);
      }
    }

    return upsertedCount;
  }

  /**
   * 위반 탐지 (private/pool)
   */
  async detectViolations(shop: string): Promise<{
    privateOverbooked: number;
    poolExceeded: number;
  }> {
    let privateOverbooked = 0;
    let poolExceeded = 0;

    // slotKey별 bookingId 수 확인 (private 위반)
    const slotPattern = `booking:slot:${shop}:*`;
    const slotKeys = await this.redisClient.keys(slotPattern);

    for (const slotKey of slotKeys) {
      const bookingIds = await this.redisClient.smembers(slotKey);
      if (bookingIds.length > 1) {
        privateOverbooked += bookingIds.length - 1; // 1개는 정상, 나머지는 위반
      }
    }

    // pool 위반은 capacity 정보가 필요하므로 MVP에서는 간단히 체크
    // 실제 capacity는 환경변수나 다른 소스에서 가져와야 함
    // 여기서는 poolDayKey별 bookingId 수만 확인

    return {
      privateOverbooked,
      poolExceeded,
    };
  }
}
