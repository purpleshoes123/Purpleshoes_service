import type { ActionFunctionArgs } from "react-router";
import { webhookReceiptResponse } from "~/domains/webhooks/webhookReceipt.server.ts";
import { updateWebhookEventStatus } from "~/domains/webhooks/webhookEventStore";
import { verifyWebhook } from "~/middleware/verifyWebhook";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { maskPII } from "~/lib/masking";
import { extractBookingInfoFromLineItem } from "~/domains/webhooks/webhookUtils";
import { groupLineItemsByBooking } from "~/domains/webhooks/webhookGrouping";
import { createHash, randomUUID } from "crypto";
import {
  resolveBookingIdByGroupIndex,
  resolveBookingIdByOrderLineIndex,
  removeConfirmedBookingRecord,
  updateConfirmedBookingTravelers,
} from "~/domains/bookings/confirmedLedger";
import { RebuildStoreKeys, type ConfirmedBookingRecord } from "~/domains/bookings/rebuildStore";
import { getTicketTypeByVariantId } from "~/domains/catalog/variantPricingService";
import { extractTravelersFromLineItems } from "~/domains/webhooks/webhookTravelers";
import { getAdminApiClient, fetchOrderLineItemsGraphQL } from "~/lib/shopifyAdmin";
import { logEvent } from "~/lib/logEvent";
import { upsertOrderBookingIdMetafield } from "~/domains/bookings/orderMetafieldService";
import {
  saveWebhookEvent,
  updateWebhookEventEvaluation,
  updateWebhookEventOrderId,
} from "~/domains/webhooks/webhookEventStore";
import { normalizeTerminalStatus } from "~/domains/webhooks/webhookVoidNormalizer";
import { extractHoldMapping } from "~/domains/webhooks/webhookHoldMapping";
import { executeHoldRelease } from "~/domains/webhooks/webhookHoldRelease";
import {
  appendLedgerEvent,
  createLog,
  extractBaseLineItems,
  extractExtensionMonthsFromLineItems,
  fetchOrderCustomerId,
  recomputeEntitlement,
  revokeGuideBaseEntitlementsForOrder,
  type EntitlementType,
} from "~/domains/checkout/guideExtension";
import { revokeTourCodesForOrder } from "~/domains/checkout/tourCredits/revokeService";
import { restoreTourCreditForOrder } from "~/domains/checkout/tourCredits/creditRestoreService";
import { revokePendingTourCreditIfNeeded } from "~/domains/checkout/tourCredits/pendingRevoke";
import { restoreGuide50ForOrder } from "~/domains/coupons/guide50Lifecycle";
import { maskCouponCode, maskCustomerId } from "~/domains/coupons/logging";
import {
  refundContainsFullyRefundedGuideKitBundle,
  refundLineItemsAreFullyRefunded,
} from "~/domains/coupons/orderUtils";
import { restoreExtra10ForOrder } from "~/domains/coupons/extra10RestoreService";
import { removeGuideBundleTour15Source } from "~/domains/coupons/tour15Sources";
import { clearCachedTour15Balance } from "~/domains/coupons/display/tour15BalanceCache";
import db from "~/db.server";

/**
 * SSOT 15.1: POST /proxy/webhooks/refunds-create
 * SSOT 15.2: Webhook HMAC 검증 (raw body 기반)
 * Phase 5-4: 환불 생성 시 confirmed 예약 해제
 * Phase 1: Webhook 이벤트 저장/멱등 파이프라인
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. HMAC 검증
  const verification = await verifyWebhook(request);
  if (!verification.verified) {
    return verification.response;
  }

  const rawBody = verification.rawBody;
  const correlationId =
    request.headers.get("X-Request-Id") || request.headers.get("X-Correlation-Id") || randomUUID();

  // Phase 1: Webhook 이벤트 저장 (멱등성 보장)
  const topic = request.headers.get("X-Shopify-Topic") || "refunds/create";
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");

  let eventResult: Awaited<ReturnType<typeof saveWebhookEvent>> | null = null;
  let processingIncomplete = false;
  try {
    eventResult = await saveWebhookEvent(
      topic,
      rawBody,
      null, // orderId는 JSON 파싱 후에 추출
      webhookId,
    );

    // 구조화 로그 추가
    console.log(
      JSON.stringify({
        message: "Webhook event saved",
        topic,
        eventKey: eventResult.eventKey,
        isDuplicate: eventResult.isDuplicate,
        correlationId,
      }),
    );

    // 중복 이벤트면 비즈니스 로직 스킵하고 200 OK 반환
    const receiptResponse = webhookReceiptResponse(eventResult);
    if (receiptResponse) {
      return receiptResponse;
    }
  } catch (error) {
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      return new Response("Webhook storage unavailable", { status: 503 });
    }
    // 이벤트 저장 실패해도 기존 로직은 계속 진행 (no-op)
    console.error(
      JSON.stringify({
        message: "Failed to save webhook event, continuing with business logic",
        topic,
        error: error instanceof Error ? error.message : String(error),
        correlationId,
      }),
    );
  }

  try {
    // 2. JSON 파싱
    const payload = JSON.parse(rawBody) as {
      id?: number | string;
      created_at?: string;
      order_id: number;
      customer?: { id?: number | string } | null;
      refund_line_items?: Array<{
        line_item_id?: number;
        product_id?: number;
        variant_id?: number;
        quantity?: number;
        properties?: Array<{ name: string; value: string }>;
        line_item?: {
          id?: number;
          product_id?: number;
          variant_id?: number;
          quantity?: number;
          properties?: Array<{ name: string; value: string }>;
          sku?: string | null;
        };
        sku?: string | null;
      }>;
      line_items?: Array<{
        id?: number;
        product_id?: number;
        variant_id?: number;
        quantity?: number;
        properties?: Array<{ name: string; value: string }>;
        sku?: string | null;
      }>;
      [key: string]: unknown;
    };

    // 3. shop 추출
    const shop = request.headers.get("X-Shopify-Shop-Domain") || (payload as any).shop || "";

    if (!shop) {
      console.error(
        JSON.stringify({
          message: "Missing shop information in webhook",
        }),
      );
      return new Response("Missing shop information", { status: 400 });
    }

    const orderId = payload.order_id?.toString();
    if (!orderId) {
      console.error(
        JSON.stringify({
          message: "Missing order ID in webhook payload",
        }),
      );
      return new Response("Missing order ID", { status: 400 });
    }

    // Phase 1: orderId가 있으면 이벤트의 orderId 업데이트
    if (eventResult && !eventResult.isDuplicate) {
      try {
        await updateWebhookEventOrderId(eventResult.eventKey, orderId);
      } catch (error) {
        // 업데이트 실패는 무시 (이미 처리되었거나 없는 경우)
      }
    }

    // Phase 2: 정규화/추출 평가 (드라이런)
    const pipelineEnabled = process.env.HOLD_RELEASE_VOID_PIPELINE_ENABLED === "true";
    const dryrun = process.env.HOLD_RELEASE_VOID_DRYRUN !== "false";
    if (pipelineEnabled && eventResult && !eventResult.isDuplicate) {
      try {
        const normalizedStatus = normalizeTerminalStatus({ topic, payload });
        const mapping = await extractHoldMapping(payload, shop);
        await updateWebhookEventEvaluation(eventResult.eventKey, {
          normalizedStatus,
          extractedHoldIds: mapping.holdIds,
          extractedAttemptIds: mapping.attemptIds,
        });

        console.log(
          JSON.stringify({
            message: "Webhook event evaluated",
            topic,
            eventKey: eventResult.eventKey,
            orderId,
            normalizedStatus,
            holdIds: mapping.holdIds,
            attemptIds: mapping.attemptIds,
            dryrun,
          }),
        );

        await executeHoldRelease({
          eventKey: eventResult.eventKey,
          orderId,
          normalizedStatus,
          holdIds: mapping.holdIds,
          attemptIds: mapping.attemptIds,
          topic,
          dryrun,
        });
      } catch (error) {
        await updateWebhookEventEvaluation(eventResult.eventKey, {
          normalizedStatus: null,
          extractedHoldIds: [],
          extractedAttemptIds: [],
          evaluationError: error instanceof Error ? error.message : String(error),
        });
        console.error(
          JSON.stringify({
            message: "Webhook event evaluation failed",
            topic,
            eventKey: eventResult.eventKey,
            orderId,
            error: error instanceof Error ? error.message : String(error),
            dryrun,
          }),
        );
      }
    }

    // 4. refund_line_items 처리
    // Phase 5-7: refund_line_items가 있으면 사용, 없으면 line_items 사용
    const rawRefundLineItems = payload.refund_line_items || [];
    const useRefundItems = rawRefundLineItems.length > 0;
    const rawLineItems = useRefundItems ? rawRefundLineItems : payload.line_items || [];
    const lineItemsToProcess = rawLineItems.map((item: any) => {
      const lineItem = item.line_item || {};
      const quantity =
        typeof item.quantity === "number"
          ? item.quantity
          : typeof lineItem.quantity === "number"
            ? lineItem.quantity
            : undefined;
      return {
        id: item.line_item_id ?? item.id ?? lineItem.id,
        product_id: item.product_id ?? lineItem.product_id,
        variant_id: item.variant_id ?? lineItem.variant_id,
        properties: item.properties ?? lineItem.properties,
        quantity,
        quantityMissing: quantity === undefined,
      };
    });

    const store = getBookingStore();
    const redisClient = (store as any).client || null;
    const durableBookings = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
    if (durableBookings && !redisClient) {
      throw new Error("Durable booking store unavailable");
    }

    const rawRefundId = payload.id ?? (payload as any).refund_id ?? (payload as any).refundId;
    let refundId = rawRefundId ? String(rawRefundId) : null;
    if (!refundId && lineItemsToProcess.length > 0) {
      const fallback = [
        orderId,
        payload.created_at || "",
        lineItemsToProcess
          .map((item: any) => item.id)
          .filter(Boolean)
          .join(","),
      ].join("|");
      if (fallback) {
        refundId = createHash("sha256").update(fallback).digest("hex");
      }
    }

    if (redisClient && refundId) {
      const refundKey = `booking:refund:processed:${shop}:${refundId}`;
      const processed = await redisClient.get(refundKey);
      if (processed) {
        // A legacy cache flag alone does not prove durable processing finished.
        if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
          return new Response("Refund processing requires reconciliation", { status: 503 });
        }
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey: null,
            bookingId: null,
            productId: null,
            travelDate: null,
            poolKey: null,
            action: "noop",
            idempotencyHit: true,
          },
          { correlationId, shop, severity: "info" },
        );
        return new Response("OK", { status: 200 });
      }
    }

    const missingQuantityIds: Array<string> = [];
    const normalizedLineItems = lineItemsToProcess.map((item: any) => {
      const quantity = typeof item.quantity === "number" ? item.quantity : 0;
      if (item.quantityMissing) {
        missingQuantityIds.push(String(item.id ?? "unknown"));
      }
      return {
        ...item,
        quantity,
      };
    });

    if (missingQuantityIds.length > 0) {
      console.warn(
        JSON.stringify(
          maskPII({
            message: "Refund line item missing quantity (treated as 0)",
            orderId: orderId.substring(0, 12) + "...",
            lineItemIds: missingQuantityIds.slice(0, 10),
          }),
        ),
      );
    }

    // Phase 5-7: line_items를 그룹으로 묶어서 그룹 기반 처리 (shop 전달)
    const groups = await groupLineItemsByBooking(
      normalizedLineItems,
      extractBookingInfoFromLineItem,
      shop,
    );

    try {
      if (groups.length === 1 && !durableBookings) {
        const bookingId = createHash("sha256")
          .update(`${shop}|${groups[0].groupKey}`)
          .digest("hex");
        const admin = await getAdminApiClient(shop);
        if (admin) {
          const metaResult = await upsertOrderBookingIdMetafield({
            admin,
            orderId,
            bookingId,
          });
          if (!metaResult.ok) {
            console.warn(
              JSON.stringify(
                maskPII({
                  message: "Order booking_id sync failed (refunds/create)",
                  orderId,
                  bookingId,
                  error: metaResult.message,
                }),
              ),
            );
          }
        } else {
          console.warn(
            JSON.stringify(
              maskPII({
                message: "Order booking_id sync skipped (admin unavailable)",
                orderId,
                bookingId,
              }),
            ),
          );
        }
      } else if (groups.length > 1) {
        console.warn(
          JSON.stringify(
            maskPII({
              message: "Order booking_id sync skipped (multiple groups)",
              orderId,
              groupCount: groups.length,
            }),
          ),
        );
      }
    } catch (error) {
      console.warn(
        JSON.stringify(
          maskPII({
            message: "Order booking_id sync error (refunds/create)",
            orderId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }

    const groupedLineItemIds = new Set(
      groups.flatMap((group) => group.lineItems.map((item) => String(item.id))),
    );

    // 그룹 단위 partial refund 처리
    for (const group of groups) {
      const { groupKey, lineItems: groupLineItems, bookingInfo } = group;
      const refunded = { adult: 0, child: 0, infant: 0 };
      const logContext = {
        productId: bookingInfo.productId,
        travelDate: bookingInfo.travelDate,
        poolKey: bookingInfo.poolKey,
      };

      for (const lineItem of groupLineItems as Array<any>) {
        const quantity = typeof lineItem.quantity === "number" ? lineItem.quantity : 0;
        if (quantity <= 0) {
          continue;
        }
        const variantId = lineItem.variant_id?.toString();
        if (!variantId) {
          continue;
        }
        const productId = lineItem.product_id?.toString() || bookingInfo.productId;
        const ticketType = await getTicketTypeByVariantId({
          shop,
          productId,
          variantId,
        });
        if (!ticketType) {
          continue;
        }
        refunded[ticketType] += quantity;
      }

      const refundedTotal = refunded.adult + refunded.child + refunded.infant;
      if (refundedTotal === 0) {
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey,
            bookingId: null,
            ...logContext,
            action: "noop",
            idempotencyHit: false,
          },
          { correlationId, shop, severity: "info" },
        );
        continue;
      }

      if (!redisClient) {
        console.warn(
          JSON.stringify(
            maskPII({
              message: "Redis client unavailable; falling back to full removal",
              orderId: orderId.substring(0, 12) + "...",
              groupKey: groupKey.substring(0, 50) + "...",
            }),
          ),
        );
        await store.removeConfirmedBookingByGroupKey(groupKey);
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey,
            bookingId: null,
            ...logContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: refunded,
            resultTravelers: null,
            reason: "redis_unavailable",
          },
          { correlationId, shop, severity: "warn" },
        );
        continue;
      }

      const bookingId = await resolveBookingIdByGroupIndex(redisClient, shop, groupKey, orderId);
      if (!bookingId) {
        if (durableBookings) {
          throw new Error("Refund booking requires ledger reconciliation");
        }
        console.warn(
          JSON.stringify(
            maskPII({
              message: "No bookingId resolved for groupKey (refunds/create)",
              orderId: orderId.substring(0, 12) + "...",
              groupKey: groupKey.substring(0, 50) + "...",
            }),
          ),
        );
        await store.removeConfirmedBookingByGroupKey(groupKey);
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey,
            bookingId: null,
            ...logContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: refunded,
            resultTravelers: null,
            reason: "bookingId_missing",
          },
          { correlationId, shop, severity: "warn" },
        );
        continue;
      }

      const bookingKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);
      const bookingData = await redisClient.get(bookingKey);
      if (!bookingData) {
        if (durableBookings) {
          throw new Error("Refund booking requires ledger reconciliation");
        }
        await store.removeConfirmedBookingByGroupKey(groupKey);
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey,
            bookingId,
            ...logContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: refunded,
            resultTravelers: null,
            reason: "booking_not_found",
          },
          { correlationId, shop, severity: "warn" },
        );
        continue;
      }

      const booking = JSON.parse(bookingData) as ConfirmedBookingRecord;
      if (!booking.travelers) {
        let inferred = extractTravelersFromLineItems(groupLineItems as any);
        if (!inferred) {
          try {
            const admin = await getAdminApiClient(shop);
            if (admin) {
              const adminLineItems = await fetchOrderLineItemsGraphQL(admin, orderId);
              inferred = extractTravelersFromLineItems(adminLineItems as any);
            }
          } catch (error) {
            console.warn(
              JSON.stringify(
                maskPII({
                  message: "Failed to fetch order for travelers inference",
                  orderId: orderId.substring(0, 12) + "...",
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          }
        }

        if (inferred) {
          booking.travelers = inferred;
          await updateConfirmedBookingTravelers(redisClient, JSON.parse(bookingData), booking);
        } else {
          console.warn(
            JSON.stringify(
              maskPII({
                message: "Booking record missing travelers; falling back to full removal",
                orderId: orderId.substring(0, 12) + "...",
                bookingId: bookingId.substring(0, 12) + "...",
              }),
            ),
          );
          const removed = await removeConfirmedBookingRecord(redisClient, shop, bookingId, {
            orderId,
            groupKey,
            cleanupOrphans: true,
            afterProjection: (removed) =>
              store.removeConfirmedBookingByGroupKey(removed?.groupKey || groupKey, {
                shop,
                orderId,
              }),
          });
          const resolvedGroupKey = removed?.groupKey || groupKey;
          logEvent(
            "webhook.refunds_create",
            {
              refundId,
              orderId,
              groupKey: resolvedGroupKey,
              bookingId,
              ...logContext,
              action: "delete",
              idempotencyHit: false,
              deltaTravelers: refunded,
              resultTravelers: null,
              reason: "legacy_fallback",
            },
            { correlationId, shop, severity: "warn" },
          );
          continue;
        }
      }

      const newTravelers = {
        adult: Math.max(0, booking.travelers.adult - refunded.adult),
        child: Math.max(0, booking.travelers.child - refunded.child),
        infant: Math.max(0, booking.travelers.infant - refunded.infant),
      };
      const remainingTotal = newTravelers.adult + newTravelers.child + newTravelers.infant;

      if (remainingTotal > 0) {
        const updated: ConfirmedBookingRecord = {
          ...booking,
          travelers: newTravelers,
          updatedAt: new Date().toISOString(),
        };
        await updateConfirmedBookingTravelers(redisClient, booking, updated);
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey,
            bookingId,
            ...logContext,
            action: "update",
            idempotencyHit: false,
            deltaTravelers: refunded,
            resultTravelers: newTravelers,
          },
          { correlationId, shop, severity: "info" },
        );
      } else {
        const removed = await removeConfirmedBookingRecord(redisClient, shop, bookingId, {
          orderId,
          groupKey,
          cleanupOrphans: true,
          afterProjection: (removed) =>
            store.removeConfirmedBookingByGroupKey(removed?.groupKey || groupKey, {
              shop,
              orderId,
            }),
        });
        const resolvedGroupKey = removed?.groupKey || groupKey;
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey: resolvedGroupKey,
            bookingId,
            ...logContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: refunded,
            resultTravelers: { adult: 0, child: 0, infant: 0 },
          },
          { correlationId, shop, severity: "info" },
        );
      }
    }

    // 그룹에 포함되지 않은 line_items 처리
    for (const lineItem of normalizedLineItems as Array<any>) {
      const lineItemId = String(lineItem.id ?? "");
      if (!lineItemId || groupedLineItemIds.has(lineItemId)) {
        continue;
      }

      const lineItemInfo = await extractBookingInfoFromLineItem(lineItem, shop);
      if (!lineItemInfo) {
        continue;
      }
      const lineItemLogContext = {
        productId: lineItemInfo.productId,
        travelDate: lineItemInfo.travelDate,
        poolKey: lineItemInfo.poolKey,
      };

      const quantity = typeof lineItem.quantity === "number" ? lineItem.quantity : 0;
      if (quantity <= 0) {
        continue;
      }

      if (!redisClient) {
        await store.removeConfirmedBooking({
          shop,
          orderId,
          lineItemId,
        });
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey: null,
            bookingId: null,
            ...lineItemLogContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: { adult: 0, child: 0, infant: 0 },
            resultTravelers: null,
            reason: "redis_unavailable",
          },
          { correlationId, shop, severity: "warn" },
        );
        continue;
      }

      const bookingId = await resolveBookingIdByOrderLineIndex(
        redisClient,
        shop,
        orderId,
        lineItemId,
      );
      if (!bookingId) {
        if (durableBookings) {
          throw new Error("Refund booking requires ledger reconciliation");
        }
        await store.removeConfirmedBooking({
          shop,
          orderId,
          lineItemId,
        });
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey: null,
            bookingId: null,
            ...lineItemLogContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: { adult: 0, child: 0, infant: 0 },
            resultTravelers: null,
            reason: "bookingId_missing",
          },
          { correlationId, shop, severity: "warn" },
        );
        continue;
      }

      const bookingKey = RebuildStoreKeys.confirmedBooking(shop, bookingId);
      const bookingData = await redisClient.get(bookingKey);
      if (!bookingData) {
        if (durableBookings) {
          throw new Error("Refund booking requires ledger reconciliation");
        }
        await store.removeConfirmedBooking({
          shop,
          orderId,
          lineItemId,
        });
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey: null,
            bookingId,
            ...lineItemLogContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: { adult: 0, child: 0, infant: 0 },
            resultTravelers: null,
            reason: "booking_not_found",
          },
          { correlationId, shop, severity: "warn" },
        );
        continue;
      }

      const booking = JSON.parse(bookingData) as ConfirmedBookingRecord;
      if (!booking.travelers) {
        let inferred = extractTravelersFromLineItems([lineItem] as any);
        if (!inferred) {
          try {
            const admin = await getAdminApiClient(shop);
            if (admin) {
              const adminLineItems = await fetchOrderLineItemsGraphQL(admin, orderId);
              inferred = extractTravelersFromLineItems(adminLineItems as any);
            }
          } catch (error) {
            console.warn(
              JSON.stringify(
                maskPII({
                  message: "Failed to fetch order for travelers inference",
                  orderId: orderId.substring(0, 12) + "...",
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          }
        }

        if (inferred) {
          booking.travelers = inferred;
          await updateConfirmedBookingTravelers(redisClient, JSON.parse(bookingData), booking);
        } else {
          console.warn(
            JSON.stringify(
              maskPII({
                message: "Booking record missing travelers; falling back to full removal",
                orderId: orderId.substring(0, 12) + "...",
                bookingId: bookingId.substring(0, 12) + "...",
              }),
            ),
          );
          const removed = await removeConfirmedBookingRecord(redisClient, shop, bookingId, {
            orderId,
            groupKey: booking.groupKey,
            cleanupOrphans: true,
            afterProjection: (removed) =>
              store.removeConfirmedBookingByGroupKey(removed?.groupKey || booking.groupKey, {
                shop,
                orderId,
              }),
          });
          const resolvedGroupKey = removed?.groupKey || booking.groupKey;
          logEvent(
            "webhook.refunds_create",
            {
              refundId,
              orderId,
              groupKey: resolvedGroupKey,
              bookingId,
              ...lineItemLogContext,
              action: "delete",
              idempotencyHit: false,
              deltaTravelers: { adult: 0, child: 0, infant: 0 },
              resultTravelers: null,
              reason: "legacy_fallback",
            },
            { correlationId, shop, severity: "warn" },
          );
          continue;
        }
      }

      const variantId = lineItem.variant_id?.toString();
      if (!variantId) {
        continue;
      }
      const productId = lineItem.product_id?.toString() || booking.productId;
      const ticketType = await getTicketTypeByVariantId({
        shop,
        productId,
        variantId,
      });
      if (!ticketType) {
        console.warn(
          JSON.stringify(
            maskPII({
              message: "Refunds create: ticketType mapping missing",
              refundId,
              orderId,
              productId,
              variantId,
            }),
          ),
        );
        continue;
      }

      const newTravelers = {
        adult: Math.max(0, booking.travelers.adult - (ticketType === "adult" ? quantity : 0)),
        child: Math.max(0, booking.travelers.child - (ticketType === "child" ? quantity : 0)),
        infant: Math.max(0, booking.travelers.infant - (ticketType === "infant" ? quantity : 0)),
      };
      const remainingTotal = newTravelers.adult + newTravelers.child + newTravelers.infant;

      if (remainingTotal > 0) {
        const updated: ConfirmedBookingRecord = {
          ...booking,
          travelers: newTravelers,
          updatedAt: new Date().toISOString(),
        };
        await updateConfirmedBookingTravelers(redisClient, booking, updated);
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey: booking.groupKey,
            bookingId,
            ...lineItemLogContext,
            action: "update",
            idempotencyHit: false,
            deltaTravelers: {
              adult: ticketType === "adult" ? quantity : 0,
              child: ticketType === "child" ? quantity : 0,
              infant: ticketType === "infant" ? quantity : 0,
            },
            resultTravelers: newTravelers,
          },
          { correlationId, shop, severity: "info" },
        );
      } else {
        const removed = await removeConfirmedBookingRecord(redisClient, shop, bookingId, {
          orderId,
          groupKey: booking.groupKey,
          cleanupOrphans: true,
          afterProjection: (removed) =>
            store.removeConfirmedBookingByGroupKey(removed?.groupKey || booking.groupKey, {
              shop,
              orderId,
            }),
        });
        const resolvedGroupKey = removed?.groupKey || booking.groupKey;
        logEvent(
          "webhook.refunds_create",
          {
            refundId,
            orderId,
            groupKey: resolvedGroupKey,
            bookingId,
            ...lineItemLogContext,
            action: "delete",
            idempotencyHit: false,
            deltaTravelers: {
              adult: ticketType === "adult" ? quantity : 0,
              child: ticketType === "child" ? quantity : 0,
              infant: ticketType === "infant" ? quantity : 0,
            },
            resultTravelers: { adult: 0, child: 0, infant: 0 },
          },
          { correlationId, shop, severity: "info" },
        );
      }
    }

    const refundLineItems = (payload.refund_line_items || []).map((item) => ({
      id: item.line_item?.id ?? item.line_item_id ?? null,
      sku: item.line_item?.sku ?? item.sku ?? null,
      quantity:
        typeof item.quantity === "number"
          ? item.quantity
          : typeof item.line_item?.quantity === "number"
            ? item.line_item.quantity
            : null,
      variant_id: item.line_item?.variant_id ?? item.variant_id ?? null,
    }));

    const baseLineItems = extractBaseLineItems(refundLineItems);
    if (baseLineItems.length > 0) {
      try {
        const admin = await getAdminApiClient(shop);
        if (!admin) {
          console.warn(
            JSON.stringify({
              message: "Guide base refund skipped (admin unavailable)",
              orderId,
              refundId,
            }),
          );
        } else {
          const customerId = await fetchOrderCustomerId(admin, orderId);
          if (!customerId) {
            console.warn(
              JSON.stringify({
                message: "Guide base refund skipped (missing customerId)",
                orderId,
                refundId,
              }),
            );
          } else {
            const revokeResult = await revokeGuideBaseEntitlementsForOrder({
              admin,
              shop,
              topic: "refunds/create",
              customerId,
              orderId,
              lineItems: baseLineItems,
              refundId,
              occurredAt: payload.created_at || new Date().toISOString(),
              rawRef: eventResult?.eventKey || undefined,
            });
            if (revokeResult.failed.length > 0 || revokeResult.skipped.length > 0) {
              console.warn(
                JSON.stringify({
                  message: "Guide base refund revoke completed with warnings",
                  orderId,
                  refundId,
                  revoked: revokeResult.revoked,
                  skipped: revokeResult.skipped,
                  failed: revokeResult.failed,
                }),
              );
            }
          }
        }
      } catch (error) {
        processingIncomplete = true;
        console.error(
          JSON.stringify({
            message: "Guide base refund processing error",
            orderId,
            refundId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    // Guide Extension 처리 (환불 라인아이템 분기)
    const extensionLineItems = refundLineItems;
    const extensionMonths =
      extensionLineItems.length > 0
        ? extractExtensionMonthsFromLineItems(extensionLineItems)
        : { PDF: 0, VIDEO: 0, BUNDLE: 0 };
    const hasExtension = Object.values(extensionMonths).some((v) => v > 0);

    if (hasExtension) {
      try {
        const admin = await getAdminApiClient(shop);
        if (!admin) {
          console.warn(
            JSON.stringify({
              message: "Guide extension refund skipped (admin unavailable)",
              orderId,
              refundId,
            }),
          );
        } else {
          const customerId = await fetchOrderCustomerId(admin, orderId);
          if (!customerId) {
            console.warn(
              JSON.stringify({
                message: "Guide extension refund skipped (missing customerId)",
                orderId,
                refundId,
              }),
            );
          } else {
            const occurredAt = payload.created_at || new Date().toISOString();
            const types: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];
            for (const type of types) {
              const months = extensionMonths[type];
              if (!months || months <= 0) {
                continue;
              }

              try {
                const appended = await appendLedgerEvent(admin, {
                  customerId,
                  entitlementType: type,
                  eventType: "REFUND",
                  months,
                  orderId,
                  refundId: refundId || undefined,
                  occurredAt,
                  note: `order_id=${orderId}|refund_id=${refundId || "unknown"}|months=${months}`,
                });
                const recomputeResult = await recomputeEntitlement({
                  admin,
                  customerId,
                  type,
                  reason: "refunds/create",
                  additionalEvents: [
                    {
                      id: appended.id,
                      entitlementType: type,
                      eventType: "REFUND",
                      months,
                      occurredAt,
                      orderId,
                      refundId: refundId || undefined,
                      note:
                        `order_id=${orderId}|refund_id=${refundId || "unknown"}` +
                        `|months=${months}`,
                    },
                  ],
                });
                await createLog(db, {
                  shop,
                  topic: "refunds/create",
                  customerId,
                  entitlementType: type,
                  eventType: "REFUND",
                  monthsDelta: -months,
                  orderId,
                  refundId: refundId || undefined,
                  status: "SUCCESS",
                  baseExpiresAt: recomputeResult.baseExpiresAt,
                  newExpiresAt: recomputeResult.newExpiresAt,
                  rawRef: eventResult?.eventKey || undefined,
                });
              } catch (error) {
                processingIncomplete = true;
                console.error(
                  JSON.stringify({
                    message: "Guide extension refund processing failed",
                    orderId,
                    refundId,
                    type,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
                try {
                  await createLog(db, {
                    shop,
                    topic: "refunds/create",
                    customerId,
                    entitlementType: type,
                    eventType: "REFUND",
                    monthsDelta: -months,
                    orderId,
                    refundId: refundId || undefined,
                    status: "FAILED",
                    errorCode: "GUIDE_EXTENSION_WEBHOOK_ERROR",
                    errorMessage: error instanceof Error ? error.message : String(error),
                    rawRef: eventResult?.eventKey || undefined,
                  });
                } catch (logError) {
                  console.error(
                    JSON.stringify({
                      message: "Guide extension refund log insert failed",
                      orderId,
                      refundId,
                      type,
                      error: logError instanceof Error ? logError.message : String(logError),
                    }),
                  );
                }
              }
            }
          }
        }
      } catch (error) {
        processingIncomplete = true;
        console.error(
          JSON.stringify({
            message: "Guide extension refund processing error",
            orderId,
            refundId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    // TOUR 쿠폰 revoke (refund)
    try {
      const admin = await getAdminApiClient(shop);
      if (!admin) {
        console.warn(
          JSON.stringify({
            message: "Tour coupon revoke skipped (admin unavailable)",
            orderId,
            refundId,
          }),
        );
      } else {
        const revokeResult = await revokeTourCodesForOrder({
          admin,
          orderId,
          reason: "refunds/create",
        });
        if (revokeResult.revoked.length > 0 || revokeResult.warnings.length > 0) {
          console.log(
            JSON.stringify({
              message: "Tour coupon revoke processed",
              orderId,
              refundId,
              revokedCodes: revokeResult.revoked,
              warnings: revokeResult.warnings,
            }),
          );
        }
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Tour coupon revoke failed",
          orderId,
          refundId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // 여행 주문 쿠폰 복원: 전량 환불인 경우에만 TOUR15/20 credit과 EXTRA10을 복원한다.
    try {
      const refundLineItems = payload.refund_line_items || [];
      const fullyRefunded = refundLineItemsAreFullyRefunded(refundLineItems);
      const payloadCustomerId = payload.customer?.id?.toString() || null;

      console.log(
        JSON.stringify({
          message: "Refund coupon restore eligibility checked",
          orderId,
          refundId,
          refundLineItemsCount: refundLineItems.length,
          fullyRefunded,
          payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
          hasPayloadCustomerId: Boolean(payloadCustomerId),
        }),
      );

      if (fullyRefunded) {
        const admin = await getAdminApiClient(shop);
        if (!admin) {
          console.warn(
            JSON.stringify({
              message: "Refund coupon restore skipped",
              orderId,
              refundId,
              reason: "ADMIN_UNAVAILABLE",
              payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
            }),
          );
        } else {
          const tourRestore = await restoreTourCreditForOrder({
            admin,
            shop,
            orderId,
            customerId: payloadCustomerId,
            refundId,
            reason: "refunds/create",
          });
          console.log(
            JSON.stringify({
              message: "Refund tour credit restore processed",
              orderId,
              refundId,
              customerIdMasked: maskCustomerId(payloadCustomerId),
              restored: tourRestore.restored,
              reason: tourRestore.reason || null,
              codeMasked: maskCouponCode(tourRestore.code),
              balanceBefore: tourRestore.balanceBefore ?? null,
              balanceAfter: tourRestore.balanceAfter ?? null,
              warnings: tourRestore.warnings,
            }),
          );

          const extra10Restore = await restoreExtra10ForOrder({
            admin,
            orderId,
            customerId: payloadCustomerId,
            refundId,
            reason: "refunds/create",
          });
          console.log(
            JSON.stringify({
              message: "Refund Extra10 restore processed",
              orderId,
              refundId,
              customerIdMasked: maskCustomerId(payloadCustomerId),
              restored: extra10Restore.restored,
              reason: extra10Restore.reason || null,
              oldCodeMasked: maskCouponCode(extra10Restore.oldCode),
              newCodeMasked: maskCouponCode(extra10Restore.newCode),
              warnings: extra10Restore.warnings,
            }),
          );
        }
      } else {
        console.log(
          JSON.stringify({
            message: "Refund coupon restore skipped",
            orderId,
            refundId,
            reason: "NOT_FULL_REFUND",
            refundLineItemsCount: refundLineItems.length,
          }),
        );
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Refund coupon restore failed",
          orderId,
          refundId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // TOUR15 출처 제거: Guide Kit 번들이 전체 환불되면 해당 번들 주문 출처만 제거한다.
    try {
      const refundLineItems = payload.refund_line_items || [];
      const guideKitFullyRefunded = refundContainsFullyRefundedGuideKitBundle(refundLineItems);
      const payloadCustomerId = payload.customer?.id?.toString() || null;

      console.log(
        JSON.stringify({
          message: "Tour15 guide bundle refund eligibility checked",
          orderId,
          refundId,
          refundLineItemsCount: refundLineItems.length,
          guideKitFullyRefunded,
          payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
          hasPayloadCustomerId: Boolean(payloadCustomerId),
        }),
      );

      if (guideKitFullyRefunded) {
        const admin = await getAdminApiClient(shop);
        let customerId = payloadCustomerId;
        const customerIdSource = payloadCustomerId ? "payload" : "admin";
        if (!customerId && admin) {
          console.log(
            JSON.stringify({
              message: "Tour15 guide bundle refund admin customer lookup start",
              orderId,
              refundId,
            }),
          );
          customerId = await fetchOrderCustomerId(admin, orderId);
        }

        if (!customerId) {
          console.warn(
            JSON.stringify({
              message: "Tour15 guide bundle refund skipped",
              orderId,
              refundId,
              reason: "MISSING_CUSTOMER_ID",
              customerIdSource,
              adminAvailable: Boolean(admin),
            }),
          );
        } else {
          const sourceResult = await removeGuideBundleTour15Source(customerId, orderId);
          let cacheInvalidated = false;
          const warnings: string[] = [];
          try {
            await clearCachedTour15Balance(customerId);
            cacheInvalidated = true;
          } catch (error) {
            warnings.push(
              `CACHE_INVALIDATE_FAILED:${error instanceof Error ? error.message : String(error)}`,
            );
          }

          let pendingTourCodeRevoked = false;
          let pendingTourCodeCleared = false;
          let pendingTourSkippedReason: string | null = null;
          if (sourceResult.entitledTour15Before && !sourceResult.entitledTour15After) {
            if (admin) {
              const pendingResult = await revokePendingTourCreditIfNeeded({
                admin,
                customerId,
                reason: "guide_bundle_refund",
              });
              pendingTourCodeRevoked = pendingResult.revoked;
              pendingTourCodeCleared = pendingResult.cleared;
              pendingTourSkippedReason = pendingResult.skippedReason || null;
              warnings.push(...pendingResult.warnings);
            } else {
              warnings.push("PENDING_TOUR_REVOKE_SKIPPED:ADMIN_UNAVAILABLE");
            }
          }

          console.log(
            JSON.stringify({
              message: "Tour15 guide bundle refund processed",
              orderId,
              refundId,
              customerIdMasked: maskCustomerId(customerId),
              customerIdSource,
              sourceRemoved: sourceResult.sourceRemoved,
              activeGuideBundleCountBefore: sourceResult.activeGuideBundleCountBefore,
              activeGuideBundleCountAfter: sourceResult.activeGuideBundleCountAfter,
              tourReviewActive: sourceResult.tourReviewActiveAfter,
              legacyEntitlementPreserved: sourceResult.legacyEntitlementPreserved || false,
              entitledTour15Before: sourceResult.entitledTour15Before,
              entitledTour15After: sourceResult.entitledTour15After,
              pendingTourCodeRevoked,
              pendingTourCodeCleared,
              pendingTourSkippedReason,
              cacheInvalidated,
              warnings,
            }),
          );
        }
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Tour15 guide bundle refund processing failed",
          orderId,
          refundId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // GUIDE50 복구: Guide Kit 번들이 전체 환불되었고 원래 만료시간이 남은 경우에만 복구
    try {
      const refundLineItems = payload.refund_line_items || [];
      const guideKitFullyRefunded = refundContainsFullyRefundedGuideKitBundle(refundLineItems);
      const payloadCustomerId = payload.customer?.id?.toString() || null;

      console.log(
        JSON.stringify({
          message: "Guide50 refund restore eligibility checked",
          orderId,
          refundId,
          refundLineItemsCount: refundLineItems.length,
          guideKitFullyRefunded,
          payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
          hasPayloadCustomerId: Boolean(payloadCustomerId),
        }),
      );

      if (guideKitFullyRefunded) {
        const admin = await getAdminApiClient(shop);
        if (!admin) {
          console.warn(
            JSON.stringify({
              message: "Guide50 restore skipped",
              orderId,
              refundId,
              reason: "ADMIN_UNAVAILABLE",
              payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
            }),
          );
        } else {
          let customerId = payloadCustomerId;
          const customerIdSource = payloadCustomerId ? "payload" : "admin";
          if (!customerId) {
            console.log(
              JSON.stringify({
                message: "Guide50 restore admin customer lookup start",
                orderId,
                refundId,
              }),
            );
            customerId = await fetchOrderCustomerId(admin, orderId);
          }

          console.log(
            JSON.stringify({
              message: "Guide50 restore customer resolved",
              orderId,
              refundId,
              customerIdMasked: maskCustomerId(customerId),
              customerIdSource,
              hasCustomerId: Boolean(customerId),
            }),
          );

          if (!customerId) {
            console.warn(
              JSON.stringify({
                message: "Guide50 restore skipped",
                orderId,
                refundId,
                reason: "MISSING_CUSTOMER_ID",
                customerIdSource,
              }),
            );
          } else {
            const restoreResult = await restoreGuide50ForOrder({ admin, customerId, orderId });
            if (restoreResult.restored || restoreResult.reason !== "NO_CONSUMED_GUIDE50") {
              console.log(
                JSON.stringify({
                  message: "Guide50 restore processed",
                  orderId,
                  refundId,
                  customerIdMasked: maskCustomerId(customerId),
                  customerIdSource,
                  restored: restoreResult.restored,
                  reason: restoreResult.reason,
                  expiresAt: restoreResult.expiresAt,
                }),
              );
            }
          }
        }
      } else {
        console.log(
          JSON.stringify({
            message: "Guide50 restore skipped",
            orderId,
            refundId,
            reason: "NOT_FULL_GUIDE_KIT_REFUND",
            refundLineItemsCount: refundLineItems.length,
          }),
        );
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Guide50 restore failed",
          orderId,
          refundId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && processingIncomplete) {
      if (eventResult?.saved) {
        await updateWebhookEventStatus(
          eventResult.eventKey,
          "FAILED",
          "Business processing requires reconciliation",
        );
      }
      return new Response("Webhook processing requires reconciliation", { status: 503 });
    }
    if (redisClient && refundId) {
      const refundKey = `booking:refund:processed:${shop}:${refundId}`;
      await redisClient.set(refundKey, "1");
    }

    // 6. 성공 응답 (200)
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && eventResult?.saved) {
      await updateWebhookEventStatus(eventResult.eventKey, "PROCESSED");
    }
    return new Response("OK", { status: 200 });
  } catch (error) {
    // JSON 파싱 에러 또는 처리 에러
    console.error(
      JSON.stringify(
        maskPII({
          message: "Refunds create webhook processing error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

    // 500 반환 (Shopify 재시도 유도)
    return new Response("Internal server error", { status: 500 });
  }
};
