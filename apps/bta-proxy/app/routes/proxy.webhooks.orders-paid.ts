import type { ActionFunctionArgs } from "react-router";
import { webhookReceiptResponse } from "~/domains/webhooks/webhookReceipt.server.ts";
import { updateWebhookEventStatus } from "~/domains/webhooks/webhookEventStore";
import { verifyWebhook } from "~/middleware/verifyWebhook";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { resolveBookingPolicy } from "~/domains/bookings/bookingConfigResolver";
import type { ConfirmationCapacity } from "~/domains/bookings/redisBookingCapacity";
import { extractBookingInfoFromLineItem } from "~/domains/webhooks/webhookUtils";
import { maskPII } from "~/lib/masking";
import { checkAvailability } from "~/domains/bookings/availabilityService";
import { groupLineItemsByBooking } from "~/domains/webhooks/webhookGrouping";
import { randomUUID } from "crypto";
import { upsertConfirmedBookingRecord } from "~/domains/bookings/confirmedLedger";
import { resolvePaidBookingId } from "~/domains/bookings/bookingIdentity.server.ts";
import { type ConfirmedBookingRecord } from "~/domains/bookings/rebuildStore";
import { makeSlotKey } from "~/domains/bookings/bookingKeys";
import { getTicketTypeByVariantId } from "~/domains/catalog/variantPricingService";
import { extractTravelersFromLineItems } from "~/domains/webhooks/webhookTravelers";
import { logEvent } from "~/lib/logEvent";
import { fetchOrderLineItemsGraphQL, getAdminApiClient } from "~/lib/shopifyAdmin";
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
  addFixedMonthDaysKstEndOfDay,
  appendLedgerEvent,
  buildBaseEventHandle,
  createLog,
  extractBaseLineItems,
  extractExtensionMonthsFromLineItems,
  fetchVariantAccessMonths,
  fetchOrderCustomerId,
  getBaseDefaultMonths,
  getCustomerEntitlements,
  listLedgerEvents,
  normalizeToKstEndOfDay,
  recomputeEntitlement,
  setCustomerEntitlementExpiresAt,
  type EntitlementType,
} from "~/domains/checkout/guideExtension";
import { addGuideBundleTour15Source, tryMarkEventOnce } from "~/domains/coupons";
import {
  extractExtra10DiscountCodes,
  extractGuide50DiscountCodes,
  orderContainsGuideKitBundle,
} from "~/domains/coupons/orderUtils";
import { consumeGuide50ForOrder } from "~/domains/coupons/guide50Lifecycle";
import { consumeExtra10ForOrder } from "~/domains/coupons/extra10Lifecycle";
import { maskCouponCode, maskCustomerId } from "~/domains/coupons/logging";
import { fetchOrderDiscountCodes } from "~/domains/checkout/tourCredits/orderQueries";
import { consumeTourCreditIfApplicable } from "~/domains/checkout/tourCredits/creditConsumeService";
import { buildKlaviyoPurchaseEventCandidates } from "~/domains/marketing/klaviyo/purchaseEventCandidates.server.ts";
import { resolveKlaviyoOrderProfile } from "~/domains/marketing/klaviyo/orderProfile.server.ts";
import {
  getKlaviyoPurchaseEventEnv,
  sendKlaviyoPurchaseEvent,
} from "~/domains/marketing/klaviyo/purchaseEvents.server.ts";
import db from "~/db.server";
import { enqueueVerifiedPurchaseEmail } from "~/domains/mail/purchase-intake.server.ts";

type OrderAttributeLike = {
  name?: string | null;
  key?: string | null;
  value?: string | null;
};

type BtaCheckoutTracePayload = {
  customer?: { id?: number | string } | null;
  discount_codes?: Array<{ code?: string | null } | string> | null;
  discount_applications?: Array<{ code?: string | null } | string> | null;
  note_attributes?: OrderAttributeLike[] | null;
  line_items?: Array<{
    properties?: OrderAttributeLike[];
  }>;
};

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function getAttributeName(attribute: OrderAttributeLike): string {
  return String(attribute.name || attribute.key || "").trim();
}

function getAttributeValue(attribute: OrderAttributeLike): string | null {
  const value = String(attribute.value || "").trim();
  return value.length > 0 ? value : null;
}

function collectAttributeValues(
  attributes: OrderAttributeLike[] | null | undefined,
  keys: Set<string>,
): string[] {
  const values: string[] = [];
  for (const attribute of attributes || []) {
    const name = getAttributeName(attribute);
    if (!keys.has(name)) {
      continue;
    }
    const value = getAttributeValue(attribute);
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function collectDiscountCodeCount(payload: BtaCheckoutTracePayload): number {
  const codes: string[] = [];
  const collect = (values: Array<{ code?: string | null } | string> | null | undefined) => {
    for (const value of values || []) {
      const code = typeof value === "string" ? value : value?.code;
      if (code && code.trim()) {
        codes.push(code.trim());
      }
    }
  };

  collect(payload.discount_codes);
  collect(payload.discount_applications);
  return uniqueStrings(codes).length;
}

function extractBtaCheckoutTrace(payload: BtaCheckoutTracePayload): {
  prepareIds: string[];
  checkoutKinds: string[];
} {
  const prepareKeys = new Set(["_bta_prepare_id", "bta_prepare_id"]);
  const kindKeys = new Set(["_bta_checkout_kind", "bta_checkout_kind"]);
  const prepareIds: string[] = [];
  const checkoutKinds: string[] = [];

  prepareIds.push(...collectAttributeValues(payload.note_attributes, prepareKeys));
  checkoutKinds.push(...collectAttributeValues(payload.note_attributes, kindKeys));

  for (const lineItem of payload.line_items || []) {
    prepareIds.push(...collectAttributeValues(lineItem.properties, prepareKeys));
    checkoutKinds.push(...collectAttributeValues(lineItem.properties, kindKeys));
  }

  return {
    prepareIds: uniqueStrings(prepareIds),
    checkoutKinds: uniqueStrings(checkoutKinds),
  };
}

/**
 * SSOT 15.1: POST /proxy/webhooks/orders-paid
 * SSOT 15.2: Webhook HMAC 검증 (raw body 기반)
 * Phase 5-4: 주문 결제 완료 시 confirmed 예약 반영
 * Phase 1: Webhook 이벤트 저장/멱등 파이프라인
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. HMAC 검증
  const verification = await verifyWebhook(request);
  if (!verification.verified) {
    return verification.response;
  }

  const rawBody = verification.rawBody;
  try {
    await enqueueVerifiedPurchaseEmail(
      rawBody,
      request.headers.get("X-Shopify-Shop-Domain") || "",
      request.headers.get("X-Shopify-Topic") || "orders/paid",
    );
  } catch {
    // Never log the order body/email. Retry intake before legacy dedup marks it seen.
    console.error("Purchase email outbox intake failed");
    return new Response("Purchase email intake unavailable", { status: 503 });
  }
  const correlationId =
    request.headers.get("X-Request-Id") || request.headers.get("X-Correlation-Id") || randomUUID();

  // Phase 1: Webhook 이벤트 저장 (멱등성 보장)
  const topic = request.headers.get("X-Shopify-Topic") || "orders/paid";
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
      id: number;
      order_number: number;
      created_at?: string;
      processed_at?: string;
      customer?: { id?: number | string } | null;
      discount_codes?: Array<{ code?: string | null } | string> | null;
      discount_applications?: Array<{ code?: string | null } | string> | null;
      note_attributes?: OrderAttributeLike[] | null;
      line_items?: Array<{
        id: number;
        product_id: number;
        variant_id?: number;
        quantity?: number;
        properties?: Array<{ name: string; value: string }>;
        sku?: string | null;
      }>;
      [key: string]: unknown;
    };

    // 3. shop 추출 (X-Shopify-Shop-Domain 헤더 또는 payload에서)
    const shop = request.headers.get("X-Shopify-Shop-Domain") || (payload as any).shop || "";

    if (!shop) {
      console.error(
        JSON.stringify({
          message: "Missing shop information in webhook",
        }),
      );
      return new Response("Missing shop information", { status: 400 });
    }

    const orderId = payload.id?.toString() || payload.order_number?.toString();
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

    // 4. line_items 처리
    const lineItems = payload.line_items || [];
    const btaCheckoutTrace = extractBtaCheckoutTrace(payload);
    if (btaCheckoutTrace.prepareIds.length > 0 || btaCheckoutTrace.checkoutKinds.length > 0) {
      console.log(
        JSON.stringify({
          message: "BTA checkout trace detected",
          orderId,
          customerIdMasked: maskCustomerId(payload.customer?.id?.toString() || null),
          prepareIds: btaCheckoutTrace.prepareIds,
          checkoutKinds: btaCheckoutTrace.checkoutKinds,
          lineItemsCount: lineItems.length,
          discountCodesCount: collectDiscountCodeCount(payload),
        }),
      );
    }
    const store = getBookingStore();
    const redisClient = (store as any).client || null;
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && !redisClient) {
      throw new Error("Durable booking store unavailable");
    }

    // Phase 3 (Coupons): Guide Kit 구매 시 TOUR15 자격 부여 (멱등 처리)
    try {
      const couponCustomerId = payload.customer?.id?.toString() || null;
      if (couponCustomerId) {
        const marked = await tryMarkEventOnce("order_paid", orderId, 180 * 24 * 60 * 60);
        if (marked && orderContainsGuideKitBundle(lineItems)) {
          const sourceResult = await addGuideBundleTour15Source(couponCustomerId, orderId);
          console.log(
            JSON.stringify({
              message: "Coupon entitlement updated (TOUR15)",
              orderId,
              customerIdMasked: maskCustomerId(couponCustomerId),
              source: "guide_bundle",
              sourceAdded: sourceResult.sourceAdded,
              activeGuideBundleCountBefore: sourceResult.activeGuideBundleCountBefore,
              activeGuideBundleCountAfter: sourceResult.activeGuideBundleCountAfter,
              tourReviewActive: sourceResult.tourReviewActiveAfter,
              entitledTour15Before: sourceResult.entitledTour15Before,
              entitledTour15After: sourceResult.entitledTour15After,
            }),
          );
        }
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Coupon entitlement update failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // Phase 3 (Coupons): GUIDE50은 Shopify usageLimit=1이지만, 테마 표시는 자체 state를 보므로
    // 결제 완료 시 내부 state도 소진 처리해야 한다.
    try {
      const couponCustomerId = payload.customer?.id?.toString() || null;
      let guide50Codes = extractGuide50DiscountCodes(payload);
      let source: "payload" | "admin" = "payload";
      console.log(
        JSON.stringify({
          message: "Guide50 consume webhook check",
          topic,
          orderId,
          customerIdMasked: maskCustomerId(couponCustomerId),
          payloadGuide50CodesCount: guide50Codes.length,
          payloadGuide50CodesMasked: guide50Codes.map(maskCouponCode),
          hasCustomerId: Boolean(couponCustomerId),
        }),
      );
      if (couponCustomerId && guide50Codes.length === 0) {
        console.log(
          JSON.stringify({
            message: "Guide50 consume admin fallback start",
            orderId,
            customerIdMasked: maskCustomerId(couponCustomerId),
          }),
        );
        const admin = await getAdminApiClient(shop);
        if (admin) {
          const adminCodes = await fetchOrderDiscountCodes(admin, orderId);
          guide50Codes = extractGuide50DiscountCodes({ discount_codes: adminCodes });
          source = "admin";
          console.log(
            JSON.stringify({
              message: "Guide50 consume admin fallback result",
              orderId,
              customerIdMasked: maskCustomerId(couponCustomerId),
              adminCodesCount: adminCodes.length,
              guide50CodesCount: guide50Codes.length,
              guide50CodesMasked: guide50Codes.map(maskCouponCode),
            }),
          );
        } else {
          console.warn(
            JSON.stringify({
              message: "Guide50 consume admin fallback skipped",
              reason: "ADMIN_UNAVAILABLE",
              orderId,
              customerIdMasked: maskCustomerId(couponCustomerId),
            }),
          );
        }
      }
      if (couponCustomerId && guide50Codes.length > 0) {
        const results = await Promise.all(
          guide50Codes.map((code) =>
            consumeGuide50ForOrder({
              customerId: couponCustomerId,
              orderId,
              code,
            }),
          ),
        );

        console.log(
          JSON.stringify({
            message: "Guide50 coupon consumed",
            orderId,
            customerIdMasked: maskCustomerId(couponCustomerId),
            codesCount: guide50Codes.length,
            codesMasked: guide50Codes.map(maskCouponCode),
            source,
            stateCleared: results.some((result) => result.stateCleared),
            resultReasons: results.map((result) => result.reason || "OK"),
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            message: "Guide50 consume skipped",
            reason: !couponCustomerId ? "MISSING_CUSTOMER_ID" : "NO_GUIDE50_CODE",
            orderId,
            customerIdMasked: maskCustomerId(couponCustomerId),
            source,
          }),
        );
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Guide50 coupon consume failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // EXTRA10은 한 고객이 동시에 1장만 보유하고, 결제 완료 후에는 내부 state에서도 사라져야 한다.
    try {
      const couponCustomerId = payload.customer?.id?.toString() || null;
      let extra10Codes = extractExtra10DiscountCodes(payload);
      let source: "payload" | "admin" = "payload";
      console.log(
        JSON.stringify({
          message: "Extra10 consume webhook check",
          topic,
          orderId,
          customerIdMasked: maskCustomerId(couponCustomerId),
          payloadExtra10CodesCount: extra10Codes.length,
          payloadExtra10CodesMasked: extra10Codes.map(maskCouponCode),
          hasCustomerId: Boolean(couponCustomerId),
        }),
      );
      if (couponCustomerId && extra10Codes.length === 0) {
        console.log(
          JSON.stringify({
            message: "Extra10 consume admin fallback start",
            orderId,
            customerIdMasked: maskCustomerId(couponCustomerId),
          }),
        );
        const admin = await getAdminApiClient(shop);
        if (admin) {
          const adminCodes = await fetchOrderDiscountCodes(admin, orderId);
          extra10Codes = extractExtra10DiscountCodes({ discount_codes: adminCodes });
          source = "admin";
          console.log(
            JSON.stringify({
              message: "Extra10 consume admin fallback result",
              orderId,
              customerIdMasked: maskCustomerId(couponCustomerId),
              adminCodesCount: adminCodes.length,
              extra10CodesCount: extra10Codes.length,
              extra10CodesMasked: extra10Codes.map(maskCouponCode),
            }),
          );
        } else {
          console.warn(
            JSON.stringify({
              message: "Extra10 consume admin fallback skipped",
              reason: "ADMIN_UNAVAILABLE",
              orderId,
              customerIdMasked: maskCustomerId(couponCustomerId),
            }),
          );
        }
      }
      if (couponCustomerId && extra10Codes.length > 0) {
        const results = await Promise.all(
          extra10Codes.map((code) =>
            consumeExtra10ForOrder({
              customerId: couponCustomerId,
              orderId,
              code,
            }),
          ),
        );

        console.log(
          JSON.stringify({
            message: "Extra10 coupon consumed",
            orderId,
            customerIdMasked: maskCustomerId(couponCustomerId),
            codesCount: extra10Codes.length,
            codesMasked: extra10Codes.map(maskCouponCode),
            source,
            stateCleared: results.some((result) => result.stateCleared),
            resultReasons: results.map((result) => result.reason || "OK"),
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            message: "Extra10 consume skipped",
            reason: !couponCustomerId ? "MISSING_CUSTOMER_ID" : "NO_EXTRA10_CODE",
            orderId,
            customerIdMasked: maskCustomerId(couponCustomerId),
            source,
          }),
        );
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Extra10 coupon consume failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // Phase 3 (Tour coupons): TOUR15/20 사용 시 크레딧 소진
    try {
      const admin = await getAdminApiClient(shop);
      if (admin) {
        await consumeTourCreditIfApplicable({
          admin,
          shop,
          orderId,
          payload,
        });
      } else {
        console.warn(
          JSON.stringify({
            message: "Tour credit consume skipped (admin unavailable)",
            orderId,
          }),
        );
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Tour credit consume failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // Phase 5-7: line_items를 그룹으로 묶기 (shop 전달)
    const groups = await groupLineItemsByBooking(lineItems, extractBookingInfoFromLineItem, shop);

    // 각 그룹당 1회만 confirmed booking 처리
    for (const group of groups) {
      const { groupKey, lineItems: groupLineItems, bookingInfo } = group;

      const slotKey = makeSlotKey(bookingInfo.productId, bookingInfo.travelDate);

      // Phase 5-5: Hold commit 처리 (첫 번째 line_item의 holdId 사용)
      let holdId: string | undefined;
      let idempotencyKey: string | undefined;

      for (const lineItem of groupLineItems) {
        const properties = lineItem.properties || [];
        const holdIdProp = properties.find((p: any) => p.name === "holdId" || p.name === "hold_id");
        const idempotencyKeyProp = properties.find(
          (p: any) =>
            p.name === "idempotencyKey" ||
            p.name === "idempotency_key" ||
            p.name === "clientRequestId",
        );

        if (holdIdProp?.value) {
          holdId = holdIdProp.value;
        }
        if (idempotencyKeyProp?.value) {
          idempotencyKey = idempotencyKeyProp.value;
        }
      }

      // Hold가 있으면 commit 처리 (첫 번째 line_item ID 사용)
      if (
        process.env.DEPLOYMENT_MODE?.trim() !== "multi-node" &&
        holdId &&
        groupLineItems.length > 0
      ) {
        try {
          await store.commitHoldToConfirmed(holdId, orderId, groupLineItems[0].id.toString());
        } catch (error) {
          // hold가 없거나 이미 만료된 경우 무시하고 계속 진행
          console.warn(
            JSON.stringify(
              maskPII({
                message: "Hold commit failed, proceeding with direct confirmed",
                holdId,
                orderId: orderId.substring(0, 10) + "...",
              }),
            ),
          );
        }
      }

      // confirmed 예약 upsert (그룹 단위, 멱등)
      // Phase 5-7: groupKey를 사용하여 그룹당 1회만 처리
      const confirmInStore = async () => {
        let capacity: ConfirmationCapacity | undefined;
        if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
          // Resolve trusted configuration, never a capacity value from checkout properties.
          // This runs after the durable intent, so lookup/conflict failures retain the paid order.
          const policy = await resolveBookingPolicy(bookingInfo.productId, shop);
          if (
            policy.bookingMode !== bookingInfo.bookingMode ||
            policy.poolKey !== bookingInfo.poolKey ||
            policy.guideUnitsRequired !== bookingInfo.guideUnitsRequired
          ) {
            throw new Error("Paid booking policy requires reconciliation");
          }
          capacity = { capacityUnits: policy.poolCapacity, ...(holdId ? { holdId } : {}) };
        }
        await store.upsertConfirmedBooking(
          {
            shop,
            orderId,
            lineItemId: groupLineItems[0].id.toString(), // 첫 번째 line_item ID 사용
            slotKey,
            productId: bookingInfo.productId,
            date: bookingInfo.travelDate,
            bookingMode: bookingInfo.bookingMode,
            poolKey: bookingInfo.poolKey,
            guideUnitsRequired: bookingInfo.guideUnitsRequired,
            groupKey, // Phase 5-7: 그룹 키 전달
          },
          capacity,
        );
        // Do not expose a free-capacity gap between releasing a hold and
        // confirming payment. Both effects precede journal APPLIED.
        if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && holdId) {
          await store.commitHoldToConfirmed(holdId, orderId, groupLineItems[0].id.toString());
        }
      };

      let travelers = extractTravelersFromLineItems(groupLineItems as any);
      if (!travelers) {
        travelers = { adult: 0, child: 0, infant: 0 };
        for (const lineItem of groupLineItems) {
          const variantId = (lineItem as any).variant_id?.toString();
          if (!variantId) {
            continue;
          }
          const productId = (lineItem as any).product_id?.toString() || bookingInfo.productId;
          const rawQuantity = (lineItem as any).quantity;
          const quantity = typeof rawQuantity === "number" ? rawQuantity : 1;
          if (quantity <= 0) {
            continue;
          }

          const ticketType = await getTicketTypeByVariantId({
            shop,
            productId,
            variantId,
          });
          if (!ticketType) {
            continue;
          }
          travelers[ticketType] += quantity;
        }
      }
      const travelersTotal = travelers.adult + travelers.child + travelers.infant;
      if (travelersTotal === 0) {
        console.warn(
          JSON.stringify(
            maskPII({
              message: "Travelers fallback failed (no travelers recovered)",
              orderId,
              groupKey,
              productId: bookingInfo.productId,
            }),
          ),
        );
      }

      const bookingId = await resolvePaidBookingId(redisClient, shop, orderId, groupKey);
      const productTitle =
        typeof groupLineItems[0]?.title === "string" ? groupLineItems[0].title : undefined;

      logEvent(
        "webhook.orders_paid",
        {
          orderId,
          groupKey,
          bookingId,
          travelers,
          productId: bookingInfo.productId,
          productTitle,
          travelDate: bookingInfo.travelDate,
          poolKey: bookingInfo.poolKey,
          bookingMode: bookingInfo.bookingMode,
        },
        {
          correlationId,
          shop,
          severity: "info",
        },
      );

      // Redis confirmed ledger upsert
      if (redisClient) {
        const now = new Date().toISOString();
        const record: ConfirmedBookingRecord = {
          bookingId,
          shop,
          productId: bookingInfo.productId,
          ...(productTitle ? { productTitle } : {}),
          travelDate: bookingInfo.travelDate,
          bookingMode: bookingInfo.bookingMode,
          poolKey: bookingInfo.poolKey,
          guideUnitsRequired: bookingInfo.guideUnitsRequired,
          ...(travelersTotal > 0 ? { travelers } : {}),
          status: "confirmed",
          orderId,
          groupKey,
          createdAt: now,
          updatedAt: now,
        };
        await upsertConfirmedBookingRecord(
          redisClient,
          record,
          groupLineItems.map((item) => item.id.toString()),
          confirmInStore,
        );
      } else {
        await confirmInStore();
      }

      try {
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
                  message: "Order booking_id sync failed",
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
      } catch (error) {
        console.warn(
          JSON.stringify(
            maskPII({
              message: "Order booking_id sync error",
              orderId,
              bookingId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }

      // Phase 5-5: 초과예약 탐지 (hold 없이 paid가 들어온 경우)
      if (!holdId && !idempotencyKey) {
        const availability = await checkAvailability({
          productId: bookingInfo.productId,
          shop,
          date: bookingInfo.travelDate,
          pax: bookingInfo.partySize,
          bookingMode: bookingInfo.bookingMode,
          poolKey: bookingInfo.poolKey,
          guideUnitsRequired: bookingInfo.guideUnitsRequired,
        });

        if (!availability.available) {
          // 초과예약 경고 로그 (PII 없이)
          console.warn(
            JSON.stringify(
              maskPII({
                message: "Potential overbooking detected",
                productId: bookingInfo.productId,
                date: bookingInfo.travelDate,
                poolKey: bookingInfo.poolKey,
                orderIdSuffix: orderId.substring(Math.max(0, orderId.length - 4)),
              }),
            ),
          );
        }
      }
    }

    // Guide line_items 정규화 (webhook → 필요 시 Admin GraphQL fallback)
    let guideLineItems = lineItems;
    let baseLineItems = extractBaseLineItems(guideLineItems);
    let extensionMonths = extractExtensionMonthsFromLineItems(guideLineItems);
    let hasExtension = Object.values(extensionMonths).some((v) => v > 0);

    if (baseLineItems.length === 0 && !hasExtension) {
      const adminFallback = await getAdminApiClient(shop);
      if (adminFallback) {
        try {
          const adminLineItems = await fetchOrderLineItemsGraphQL(adminFallback, orderId);
          if (adminLineItems.length > 0) {
            guideLineItems = adminLineItems;
            baseLineItems = extractBaseLineItems(guideLineItems);
            extensionMonths = extractExtensionMonthsFromLineItems(guideLineItems);
            hasExtension = Object.values(extensionMonths).some((v) => v > 0);
          }
        } catch (error) {
          if (process.env.DEBUG_BOOKING === "1") {
            console.warn(
              JSON.stringify({
                message: "Guide line_items fallback failed",
                orderId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }
      }
    }

    if (process.env.DEBUG_BOOKING === "1" && baseLineItems.length === 0 && !hasExtension) {
      console.warn(
        JSON.stringify({
          message: "Guide line_items not matched",
          orderId,
          lineItemCount: guideLineItems.length,
          lineItems: guideLineItems.map((item) => ({
            sku: item.sku ?? null,
            variant_id: item.variant_id ?? null,
            quantity: item.quantity ?? null,
          })),
        }),
      );
    }

    // Guide Base 처리 (본상품 라인아이템 분기)
    if (baseLineItems.length > 0) {
      try {
        const admin = await getAdminApiClient(shop);
        if (!admin) {
          console.warn(
            JSON.stringify({
              message: "Guide base skipped (admin unavailable)",
              orderId,
            }),
          );
        } else {
          let customerId =
            payload.customer?.id?.toString() || (await fetchOrderCustomerId(admin, orderId));

          if (!customerId) {
            console.warn(
              JSON.stringify({
                message: "Guide base skipped (missing customerId)",
                orderId,
              }),
            );
          } else {
            const customerGid = customerId.startsWith("gid://")
              ? customerId
              : `gid://shopify/Customer/${customerId}`;
            const occurredAt =
              payload.processed_at || payload.created_at || new Date().toISOString();
            const entitlements = await getCustomerEntitlements(admin, customerGid);

            const uniqueByType = new Map<EntitlementType, (typeof baseLineItems)[number]>();
            for (const item of baseLineItems) {
              if (uniqueByType.has(item.type)) {
                console.warn(
                  JSON.stringify({
                    message: "Guide base duplicate line item skipped",
                    orderId,
                    type: item.type,
                  }),
                );
                continue;
              }
              uniqueByType.set(item.type, item);
            }

            const toTimestamp = (value?: string | null): number | null => {
              if (!value) {
                return null;
              }
              const date = new Date(value);
              if (Number.isNaN(date.getTime())) {
                return null;
              }
              return date.getTime();
            };

            const getLatestTimestamp = (
              records: Array<{ occurredAt?: string | null }>,
            ): number | null => {
              let latest: number | null = null;
              for (const record of records) {
                const ts = toTimestamp(record.occurredAt);
                if (ts === null) {
                  continue;
                }
                if (latest === null || ts > latest) {
                  latest = ts;
                }
              }
              return latest;
            };

            for (const [type, item] of uniqueByType.entries()) {
              const existingValue = entitlements[type] ?? null;
              let baseEvents: Awaited<ReturnType<typeof listLedgerEvents>> = [];
              let baseForOrder = false;
              let baseRefundActive = false;
              if (!existingValue) {
                const events = await listLedgerEvents(admin, {
                  customerId: customerGid,
                  type,
                });
                baseEvents = events.filter((event) => event.eventType === "BASE");
                baseForOrder = baseEvents.some((event) => event.orderId === orderId);
                const refundEvents = events.filter(
                  (event) =>
                    event.eventType === "REFUND" &&
                    typeof event.note === "string" &&
                    event.note.includes("base_refund=true"),
                );
                const latestBaseAt = getLatestTimestamp(baseEvents);
                const latestRefundAt = getLatestTimestamp(refundEvents);
                baseRefundActive =
                  latestRefundAt !== null &&
                  (latestBaseAt === null || latestRefundAt > latestBaseAt);
              }

              if (existingValue) {
                await createLog(db, {
                  shop,
                  topic: "orders/paid",
                  customerId: customerGid,
                  entitlementType: type,
                  eventType: "BASE_SKIP",
                  monthsDelta: 0,
                  orderId,
                  previousExpiresAt: existingValue,
                  newExpiresAt: existingValue,
                  status: "SUCCESS",
                  rawRef: eventResult?.eventKey || undefined,
                });
                continue;
              }

              if (baseForOrder || (baseEvents.length > 0 && !baseRefundActive)) {
                try {
                  const recomputeResult = await recomputeEntitlement({
                    admin,
                    customerId: customerGid,
                    type,
                    reason: "orders/paid base sync",
                  });
                  await createLog(db, {
                    shop,
                    topic: "orders/paid",
                    customerId: customerGid,
                    entitlementType: type,
                    eventType: "BASE_SYNC",
                    monthsDelta: 0,
                    orderId,
                    baseExpiresAt: recomputeResult.baseExpiresAt,
                    previousExpiresAt: existingValue,
                    newExpiresAt: recomputeResult.newExpiresAt,
                    status: "SUCCESS",
                    rawRef: eventResult?.eventKey || undefined,
                  });
                } catch (error) {
                  processingIncomplete = true;
                  await createLog(db, {
                    shop,
                    topic: "orders/paid",
                    customerId: customerGid,
                    entitlementType: type,
                    eventType: "BASE_SYNC",
                    monthsDelta: 0,
                    orderId,
                    status: "FAILED",
                    errorCode: "GUIDE_EXTENSION_WEBHOOK_ERROR",
                    errorMessage: error instanceof Error ? error.message : String(error),
                    rawRef: eventResult?.eventKey || undefined,
                  });
                }
                continue;
              }

              if (item.quantity && item.quantity > 1) {
                console.warn(
                  JSON.stringify({
                    message: "Guide base line item quantity > 1",
                    orderId,
                    type,
                    quantity: item.quantity,
                  }),
                );
              }

              let months: number | null = null;
              if (item.variantId !== null && item.variantId !== undefined) {
                try {
                  months = await fetchVariantAccessMonths(admin, item.variantId);
                } catch (error) {
                  console.warn(
                    JSON.stringify({
                      message: "Guide base months lookup failed",
                      orderId,
                      type,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  );
                }
              }
              if (!months) {
                months = getBaseDefaultMonths(type);
              }

              const baseExpiresAt = addFixedMonthDaysKstEndOfDay(
                normalizeToKstEndOfDay(occurredAt),
                months,
              );

              await appendLedgerEvent(admin, {
                customerId: customerGid,
                entitlementType: type,
                eventType: "BASE",
                months: 0,
                orderId,
                lineItemId: item.lineItemId,
                occurredAt,
                handle: buildBaseEventHandle(customerGid, type, orderId),
                baseExpiresAt,
                note: `order_id=${orderId}|base_expires_at=${baseExpiresAt}|months=${months}`,
              });

              await setCustomerEntitlementExpiresAt(admin, customerGid, type, baseExpiresAt);

              await createLog(db, {
                shop,
                topic: "orders/paid",
                customerId: customerGid,
                entitlementType: type,
                eventType: "BASE",
                monthsDelta: months,
                orderId,
                baseExpiresAt,
                previousExpiresAt: existingValue,
                newExpiresAt: baseExpiresAt,
                status: "SUCCESS",
                rawRef: eventResult?.eventKey || undefined,
              });
            }
          }
        }
      } catch (error) {
        processingIncomplete = true;
        console.error(
          JSON.stringify({
            message: "Guide base processing error",
            orderId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    // Guide Extension 처리 (연장권 라인아이템 분기)
    if (hasExtension) {
      try {
        const admin = await getAdminApiClient(shop);
        if (!admin) {
          console.warn(
            JSON.stringify({
              message: "Guide extension skipped (admin unavailable)",
              orderId,
            }),
          );
        } else {
          let customerId =
            payload.customer?.id?.toString() || (await fetchOrderCustomerId(admin, orderId));

          if (!customerId) {
            console.warn(
              JSON.stringify({
                message: "Guide extension skipped (missing customerId)",
                orderId,
              }),
            );
          } else {
            const customerGid = customerId.startsWith("gid://")
              ? customerId
              : `gid://shopify/Customer/${customerId}`;
            const occurredAt =
              payload.processed_at || payload.created_at || new Date().toISOString();

            const types: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];
            for (const type of types) {
              const months = extensionMonths[type];
              if (!months || months <= 0) {
                continue;
              }

              try {
                const appended = await appendLedgerEvent(admin, {
                  customerId: customerGid,
                  entitlementType: type,
                  eventType: "EXTEND",
                  months,
                  orderId,
                  occurredAt,
                  note: `order_id=${orderId}|months=${months}`,
                });
                const recomputeResult = await recomputeEntitlement({
                  admin,
                  customerId: customerGid,
                  type,
                  reason: "orders/paid",
                  additionalEvents: [
                    {
                      id: appended.id,
                      entitlementType: type,
                      eventType: "EXTEND",
                      months,
                      occurredAt,
                      orderId,
                      note: `order_id=${orderId}|months=${months}`,
                    },
                  ],
                });
                await createLog(db, {
                  shop,
                  topic: "orders/paid",
                  customerId: customerGid,
                  entitlementType: type,
                  eventType: "EXTEND",
                  monthsDelta: months,
                  orderId,
                  status: "SUCCESS",
                  baseExpiresAt: recomputeResult.baseExpiresAt,
                  newExpiresAt: recomputeResult.newExpiresAt,
                  rawRef: eventResult?.eventKey || undefined,
                });
              } catch (error) {
                processingIncomplete = true;
                console.error(
                  JSON.stringify({
                    message: "Guide extension processing failed",
                    orderId,
                    type,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
                try {
                  await createLog(db, {
                    shop,
                    topic: "orders/paid",
                    customerId: customerGid,
                    entitlementType: type,
                    eventType: "EXTEND",
                    monthsDelta: months,
                    orderId,
                    status: "FAILED",
                    errorCode: "GUIDE_EXTENSION_WEBHOOK_ERROR",
                    errorMessage: error instanceof Error ? error.message : String(error),
                    rawRef: eventResult?.eventKey || undefined,
                  });
                } catch (logError) {
                  console.error(
                    JSON.stringify({
                      message: "Guide extension log insert failed",
                      orderId,
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
            message: "Guide extension processing error",
            orderId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    // Klaviyo 구매 이벤트: 결제 완료 후 식별된 가이드킷/연장/투어 구매를 전송한다.
    // 실패해도 주문 후처리 결과를 깨지 않도록 마지막 단계에서 격리한다.
    try {
      const candidates = buildKlaviyoPurchaseEventCandidates({
        shop,
        orderId,
        orderNumber: payload.order_number,
        guideLineItems,
        bookingGroups: groups,
      });

      console.log(
        JSON.stringify({
          message: "Klaviyo purchase event candidates built",
          orderId,
          orderNumber: payload.order_number,
          candidatesCount: candidates.length,
          metrics: candidates.map((candidate) => candidate.metricName),
        }),
      );

      if (candidates.length > 0) {
        const klaviyoEnv = getKlaviyoPurchaseEventEnv();
        if (!klaviyoEnv.enabled || !klaviyoEnv.privateApiKey) {
          if (klaviyoEnv.enabled || klaviyoEnv.logDisabled) {
            console.info(
              JSON.stringify({
                message: "Klaviyo purchase events skipped",
                orderId,
                orderNumber: payload.order_number,
                reason: !klaviyoEnv.enabled ? "disabled" : "missing_api_key",
                candidatesCount: candidates.length,
              }),
            );
          }
        } else {
          const admin = await getAdminApiClient(shop);
          const profile = await resolveKlaviyoOrderProfile({
            admin,
            orderId,
            payload,
          });
          const occurredAt = payload.processed_at || payload.created_at || new Date().toISOString();

          const results = await Promise.all(
            candidates.map((candidate) =>
              sendKlaviyoPurchaseEvent({
                env: klaviyoEnv,
                input: {
                  metricName: candidate.metricName,
                  uniqueId: candidate.uniqueId,
                  email: profile.email || "",
                  customerId: profile.customerId,
                  eventKind: candidate.eventKind,
                  option: candidate.option,
                  occurredAt,
                  properties: candidate.properties,
                },
              }),
            ),
          );

          console.log(
            JSON.stringify({
              message: "Klaviyo purchase events processed",
              orderId,
              orderNumber: payload.order_number,
              profileSource: profile.source,
              hasProfileEmail: Boolean(profile.email),
              candidatesCount: candidates.length,
              sentCount: results.filter((result) => result.status === "SENT").length,
              skippedCount: results.filter((result) => result.status === "SKIPPED").length,
              failedCount: results.filter((result) => result.status === "FAILED").length,
              resultStatuses: results.map((result) => result.status),
            }),
          );
        }
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Klaviyo purchase event processing failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // 5. 성공 응답 (200)
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node" && eventResult?.saved) {
      if (processingIncomplete) {
        await updateWebhookEventStatus(
          eventResult.eventKey,
          "FAILED",
          "Business processing requires reconciliation",
        );
        return new Response("Webhook processing requires reconciliation", { status: 503 });
      }
      await updateWebhookEventStatus(eventResult.eventKey, "PROCESSED");
    }
    return new Response("OK", { status: 200 });
  } catch (error) {
    // JSON 파싱 에러 또는 처리 에러
    console.error(
      JSON.stringify(
        maskPII({
          message: "Orders paid webhook processing error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

    // 500 반환 (Shopify 재시도 유도)
    return new Response("Internal server error", { status: 500 });
  }
};
