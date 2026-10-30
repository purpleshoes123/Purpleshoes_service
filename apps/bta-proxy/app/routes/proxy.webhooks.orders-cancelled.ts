import type { ActionFunctionArgs } from "react-router";
import { webhookReceiptResponse } from "~/domains/webhooks/webhookReceipt.server.ts";
import { updateWebhookEventStatus } from "~/domains/webhooks/webhookEventStore";
import { verifyWebhook } from "~/middleware/verifyWebhook";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { maskPII } from "~/lib/masking";
import { extractBookingInfoFromLineItem } from "~/domains/webhooks/webhookUtils";
import { groupLineItemsByBooking } from "~/domains/webhooks/webhookGrouping";
import { getAdminApiClient, fetchOrderLineItemsGraphQL } from "~/lib/shopifyAdmin";
import { upsertOrderBookingIdMetafield } from "~/domains/bookings/orderMetafieldService";
import {
  resolveBookingIdsByOrderIndex,
  resolveBookingIdByGroupIndex,
  removeConfirmedBookingRecord,
} from "~/domains/bookings/confirmedLedger";
import { createHash, randomUUID } from "crypto";
import { logEvent } from "~/lib/logEvent";
import {
  saveWebhookEvent,
  updateWebhookEventEvaluation,
  updateWebhookEventOrderId,
} from "~/domains/webhooks/webhookEventStore";
import { normalizeTerminalStatus } from "~/domains/webhooks/webhookVoidNormalizer";
import { extractHoldMapping } from "~/domains/webhooks/webhookHoldMapping";
import { executeHoldRelease } from "~/domains/webhooks/webhookHoldRelease";
import { revokeTourCodesForOrder } from "~/domains/checkout/tourCredits/revokeService";
import { restoreTourCreditForOrder } from "~/domains/checkout/tourCredits/creditRestoreService";
import { revokePendingTourCreditIfNeeded } from "~/domains/checkout/tourCredits/pendingRevoke";
import { restoreGuide50ForOrder } from "~/domains/coupons/guide50Lifecycle";
import { maskCouponCode, maskCustomerId } from "~/domains/coupons/logging";
import { restoreExtra10ForOrder } from "~/domains/coupons/extra10RestoreService";
import { fetchOrderCustomerId } from "~/domains/checkout/guideExtension/orderCustomer";
import {
  extractBaseLineItems,
  revokeGuideBaseEntitlementsForOrder,
} from "~/domains/checkout/guideExtension";
import { orderContainsGuideKitBundle } from "~/domains/coupons/orderUtils";
import { removeGuideBundleTour15Source } from "~/domains/coupons/tour15Sources";
import { clearCachedTour15Balance } from "~/domains/coupons/display/tour15BalanceCache";

/**
 * SSOT 15.1: POST /proxy/webhooks/orders-cancelled
 * SSOT 15.2: Webhook HMAC 검증 (raw body 기반)
 * Phase 5-4: 주문 취소 시 confirmed 예약 해제
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
  const topic = request.headers.get("X-Shopify-Topic") || "orders/cancelled";
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
      customer?: { id?: number | string } | null;
      line_items?: Array<{
        id: number;
        product_id?: number;
        variant_id?: number;
        properties?: Array<{ name: string; value: string }>;
      }>;
      note_attributes?: Array<{ name: string; value: string }>;
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
    const forceCancel = process.env.HOLD_RELEASE_CANCEL_FORCE === "true";
    if (!pipelineEnabled) {
      console.log(
        JSON.stringify({
          message: "Hold release pipeline disabled",
          topic,
          orderId,
          correlationId,
        }),
      );
    } else if (!eventResult) {
      console.log(
        JSON.stringify({
          message: "Hold release skipped: missing eventResult",
          topic,
          orderId,
          correlationId,
        }),
      );
    } else if (eventResult.isDuplicate) {
      console.log(
        JSON.stringify({
          message: "Hold release skipped: duplicate event",
          topic,
          eventKey: eventResult.eventKey,
          orderId,
          correlationId,
        }),
      );
    } else {
      try {
        const normalizedStatus = normalizeTerminalStatus({ topic, payload });
        let mapping = await extractHoldMapping(payload, shop);
        let mappingSource: "payload" | "admin" = "payload";

        if (mapping.holdIds.length === 0 || mapping.attemptIds.length === 0) {
          try {
            const admin = await getAdminApiClient(shop);
            if (admin) {
              const adminLineItems = await fetchOrderLineItemsGraphQL(admin, orderId);
              if (adminLineItems.length > 0) {
                const fallbackPayload = {
                  line_items: adminLineItems.map((item) => ({
                    id: item.id,
                    product_id: item.product_id,
                    variant_id: item.variant_id,
                    properties: item.properties || [],
                  })),
                  note_attributes: Array.isArray(payload.note_attributes)
                    ? payload.note_attributes
                    : [],
                };
                const fallbackMapping = await extractHoldMapping(fallbackPayload, shop);
                if (fallbackMapping.holdIds.length > 0 || fallbackMapping.attemptIds.length > 0) {
                  mapping = fallbackMapping;
                  mappingSource = "admin";
                }
              }
            }
          } catch (fallbackError) {
            console.warn(
              JSON.stringify({
                message: "Fallback hold mapping failed",
                topic,
                orderId,
                error:
                  fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              }),
            );
          }
        }
        if (mapping.holdIds.length === 0) {
          console.warn(
            JSON.stringify({
              message: "Hold release mapping missing holdId",
              topic,
              orderId,
              mappingSource,
              correlationId,
            }),
          );
        }
        if (mapping.attemptIds.length === 0) {
          console.warn(
            JSON.stringify({
              message: "Hold release mapping missing attemptId",
              topic,
              orderId,
              mappingSource,
              correlationId,
            }),
          );
        }
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
            mappingSource,
            forceCancel,
            correlationId,
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
          forceCancel,
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

    // TOUR 쿠폰 revoke (cancelled)
    try {
      const admin = await getAdminApiClient(shop);
      if (!admin) {
        console.warn(
          JSON.stringify({
            message: "Tour coupon revoke skipped (admin unavailable)",
            orderId,
          }),
        );
      } else {
        const revokeResult = await revokeTourCodesForOrder({
          admin,
          orderId,
          reason: "orders/cancelled",
        });
        if (revokeResult.revoked.length > 0 || revokeResult.warnings.length > 0) {
          console.log(
            JSON.stringify({
              message: "Tour coupon revoke processed",
              orderId,
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
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // 여행 주문 쿠폰 복원: orders/cancelled는 주문 전체 취소로 간주한다.
    try {
      const payloadCustomerId = payload.customer?.id?.toString() || null;
      console.log(
        JSON.stringify({
          message: "Cancellation coupon restore eligibility checked",
          orderId,
          payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
          hasPayloadCustomerId: Boolean(payloadCustomerId),
        }),
      );

      const admin = await getAdminApiClient(shop);
      if (!admin) {
        console.warn(
          JSON.stringify({
            message: "Cancellation coupon restore skipped",
            orderId,
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
          reason: "orders/cancelled",
        });
        console.log(
          JSON.stringify({
            message: "Cancellation tour credit restore processed",
            orderId,
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
          reason: "orders/cancelled",
        });
        console.log(
          JSON.stringify({
            message: "Cancellation Extra10 restore processed",
            orderId,
            customerIdMasked: maskCustomerId(payloadCustomerId),
            restored: extra10Restore.restored,
            reason: extra10Restore.reason || null,
            oldCodeMasked: maskCouponCode(extra10Restore.oldCode),
            newCodeMasked: maskCouponCode(extra10Restore.newCode),
            warnings: extra10Restore.warnings,
          }),
        );
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Cancellation coupon restore failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // GUIDE50 복구: 주문 전체 취소이며 원래 만료시간이 남은 경우에만 기존 만료시간으로 재발급
    try {
      const payloadCustomerId = payload.customer?.id?.toString() || null;
      console.log(
        JSON.stringify({
          message: "Guide50 restore webhook check",
          topic,
          orderId,
          payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
          hasPayloadCustomerId: Boolean(payloadCustomerId),
        }),
      );

      const admin = await getAdminApiClient(shop);
      if (!admin) {
        console.warn(
          JSON.stringify({
            message: "Guide50 restore skipped",
            orderId,
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
            }),
          );
          customerId = await fetchOrderCustomerId(admin, orderId);
        }

        console.log(
          JSON.stringify({
            message: "Guide50 restore customer resolved",
            orderId,
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
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Guide50 restore failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // TOUR15 출처 제거: Guide Kit 번들 주문이 취소되면 해당 번들 주문 출처만 제거한다.
    try {
      const payloadLineItems = payload.line_items || [];
      let guideKitBundleCancelled = orderContainsGuideKitBundle(payloadLineItems);
      let lineItemsSource: "payload" | "admin" = "payload";
      let admin = await getAdminApiClient(shop);

      if (!guideKitBundleCancelled && admin) {
        try {
          const adminLineItems = await fetchOrderLineItemsGraphQL(admin, orderId);
          if (adminLineItems.length > 0) {
            guideKitBundleCancelled = orderContainsGuideKitBundle(adminLineItems as any);
            lineItemsSource = "admin";
          }
        } catch (error) {
          console.warn(
            JSON.stringify({
              message: "Tour15 guide bundle cancel admin line item lookup failed",
              orderId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      const payloadCustomerId = payload.customer?.id?.toString() || null;
      console.log(
        JSON.stringify({
          message: "Tour15 guide bundle cancel eligibility checked",
          orderId,
          lineItemsCount: payloadLineItems.length,
          lineItemsSource,
          guideKitBundleCancelled,
          payloadCustomerIdMasked: maskCustomerId(payloadCustomerId),
          hasPayloadCustomerId: Boolean(payloadCustomerId),
          adminAvailable: Boolean(admin),
        }),
      );

      if (guideKitBundleCancelled) {
        let customerId = payloadCustomerId;
        const customerIdSource = payloadCustomerId ? "payload" : "admin";
        if (!customerId) {
          if (!admin) {
            admin = await getAdminApiClient(shop);
          }
          if (admin) {
            console.log(
              JSON.stringify({
                message: "Tour15 guide bundle cancel admin customer lookup start",
                orderId,
              }),
            );
            customerId = await fetchOrderCustomerId(admin, orderId);
          }
        }

        if (!customerId) {
          console.warn(
            JSON.stringify({
              message: "Tour15 guide bundle cancel skipped",
              orderId,
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
                reason: "guide_bundle_cancel",
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
              message: "Tour15 guide bundle cancel processed",
              orderId,
              customerIdMasked: maskCustomerId(customerId),
              customerIdSource,
              lineItemsSource,
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
          message: "Tour15 guide bundle cancel processing failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // Guide Base entitlement revoke: 주문 취소 시 기본권 구매 효력을 제거한다.
    try {
      let guideLineItems = payload.line_items || [];
      let baseLineItems = extractBaseLineItems(guideLineItems);
      let lineItemsSource: "payload" | "admin" = "payload";
      const admin = await getAdminApiClient(shop);

      if (baseLineItems.length === 0 && admin) {
        try {
          const adminLineItems = await fetchOrderLineItemsGraphQL(admin, orderId);
          if (adminLineItems.length > 0) {
            guideLineItems = adminLineItems as any;
            baseLineItems = extractBaseLineItems(guideLineItems);
            lineItemsSource = "admin";
          }
        } catch (error) {
          console.warn(
            JSON.stringify({
              message: "Guide base cancel admin line item lookup failed",
              orderId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }

      if (baseLineItems.length > 0) {
        if (!admin) {
          console.warn(
            JSON.stringify({
              message: "Guide base cancel skipped (admin unavailable)",
              orderId,
              lineItemsSource,
            }),
          );
        } else {
          const payloadCustomerId = payload.customer?.id?.toString() || null;
          const customerId = payloadCustomerId || (await fetchOrderCustomerId(admin, orderId));
          if (!customerId) {
            console.warn(
              JSON.stringify({
                message: "Guide base cancel skipped (missing customerId)",
                orderId,
                lineItemsSource,
              }),
            );
          } else {
            const revokeResult = await revokeGuideBaseEntitlementsForOrder({
              admin,
              shop,
              topic: "orders/cancelled",
              customerId,
              orderId,
              lineItems: baseLineItems,
              occurredAt:
                typeof (payload as any).cancelled_at === "string"
                  ? (payload as any).cancelled_at
                  : typeof (payload as any).created_at === "string"
                    ? (payload as any).created_at
                    : new Date().toISOString(),
              rawRef: eventResult?.eventKey || undefined,
            });
            if (revokeResult.failed.length > 0 || revokeResult.skipped.length > 0) {
              console.warn(
                JSON.stringify({
                  message: "Guide base cancel revoke completed with warnings",
                  orderId,
                  lineItemsSource,
                  revoked: revokeResult.revoked,
                  skipped: revokeResult.skipped,
                  failed: revokeResult.failed,
                }),
              );
            }
          }
        }
      }
    } catch (error) {
      processingIncomplete = true;
      console.error(
        JSON.stringify({
          message: "Guide base cancel processing failed",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // 4. line_items 처리
    const lineItems = payload.line_items || [];
    const store = getBookingStore();
    const redisClient = (store as any).client || null;
    const durableBookings = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
    if (durableBookings && !redisClient) {
      throw new Error("Durable booking store unavailable");
    }

    // Phase 5-7: line_items를 그룹으로 묶어서 그룹 기반 해제 (shop 전달)
    const groups = await groupLineItemsByBooking(lineItems, extractBookingInfoFromLineItem, shop);

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
                  message: "Order booking_id sync failed (orders/cancelled)",
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
            message: "Order booking_id sync error (orders/cancelled)",
            orderId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }

    // In the fleet, capacity removal belongs inside the durable REMOVE below.
    // Never modify legacy counters before its accepted intent is persisted.
    for (const group of durableBookings ? [] : groups) {
      const { groupKey } = group;
      const logContext = {
        productId: group.bookingInfo.productId,
        travelDate: group.bookingInfo.travelDate,
        poolKey: group.bookingInfo.poolKey,
      };

      // 그룹 기반으로 confirmed 해제
      try {
        await store.removeConfirmedBookingByGroupKey(groupKey);
        const bookingId = createHash("sha256").update(`${shop}|${groupKey}`).digest("hex");
        logEvent(
          "webhook.orders_cancelled",
          {
            orderId,
            groupKey,
            bookingId,
            ...logContext,
            action: "delete",
          },
          { correlationId, shop, severity: "info" },
        );
      } catch (error) {
        // 그룹 기반 해제 실패 시 기존 방식(lineItemId 기반)으로 폴백
        processingIncomplete = true;
        console.warn(
          JSON.stringify(
            maskPII({
              message: "Group-based removal failed, falling back to lineItemId-based",
              groupKey: groupKey.substring(0, 50) + "...",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );

        // 기존 방식: 각 line_item별로 제거
        for (const lineItem of group.lineItems) {
          await store.removeConfirmedBooking({
            shop,
            orderId,
            lineItemId: lineItem.id.toString(),
          });
        }
        logEvent(
          "webhook.orders_cancelled",
          {
            orderId,
            groupKey,
            bookingId: null,
            ...logContext,
            action: "delete",
            reason: "group_removal_failed",
          },
          { correlationId, shop, severity: "warn" },
        );
      }
    }

    // 그룹에 포함되지 않은 line_items 처리 (기존 방식)
    for (const lineItem of durableBookings ? [] : lineItems) {
      const lineItemInfo = await extractBookingInfoFromLineItem(lineItem, shop);
      if (!lineItemInfo) {
        // 여행상품이 아니면 스킵
        continue;
      }

      const lineItemLogContext = {
        productId: lineItemInfo.productId,
        travelDate: lineItemInfo.travelDate,
        poolKey: lineItemInfo.poolKey,
      };

      // 이미 그룹에서 처리되었는지 확인
      const alreadyProcessed = groups.some((group) =>
        group.lineItems.some((item) => item.id === lineItem.id),
      );

      if (!alreadyProcessed) {
        // confirmed 예약 제거 (멱등)
        await store.removeConfirmedBooking({
          shop,
          orderId,
          lineItemId: lineItem.id.toString(),
        });
        logEvent(
          "webhook.orders_cancelled",
          {
            orderId,
            groupKey: null,
            bookingId: null,
            ...lineItemLogContext,
            action: "delete",
            reason: "lineItem_fallback",
          },
          { correlationId, shop, severity: "info" },
        );
      }
    }

    // 5. Redis confirmed ledger 정리
    if (redisClient) {
      let bookingIds = await resolveBookingIdsByOrderIndex(redisClient, shop, orderId);
      const groupKeyByBookingId = new Map<string, string>();

      if (bookingIds.length === 0) {
        // Admin API로 order 조회 후 groupKey → idx:group으로 resolve
        try {
          const admin = await getAdminApiClient(shop);
          if (admin) {
            const adminLineItems = await fetchOrderLineItemsGraphQL(admin, orderId);
            const adminGroups = await groupLineItemsByBooking(
              adminLineItems,
              extractBookingInfoFromLineItem,
              shop,
            );
            for (const group of adminGroups) {
              const bookingId = await resolveBookingIdByGroupIndex(
                redisClient,
                shop,
                group.groupKey,
                orderId,
              );
              if (bookingId) {
                bookingIds.push(bookingId);
                groupKeyByBookingId.set(bookingId, group.groupKey);
              }
            }
          }
        } catch (error) {
          console.warn(
            JSON.stringify(
              maskPII({
                message: "Failed to fetch order for ledger cleanup",
                orderId: orderId.substring(0, 12) + "...",
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          );
        }
      }

      if (bookingIds.length === 0) {
        if (durableBookings && groups.length > 0) {
          throw new Error("Booking cancellation requires ledger reconciliation");
        }
        console.warn(
          JSON.stringify(
            maskPII({
              message: "No bookingId resolved for ledger cleanup (orders/cancelled)",
              orderId: orderId.substring(0, 12) + "...",
              shop,
            }),
          ),
        );
        logEvent(
          "webhook.orders_cancelled",
          {
            orderId,
            groupKey: null,
            bookingId: null,
            productId: null,
            travelDate: null,
            poolKey: null,
            action: "noop",
          },
          { correlationId, shop, severity: "info" },
        );
      } else {
        for (const bookingId of new Set(bookingIds)) {
          const record = await removeConfirmedBookingRecord(redisClient, shop, bookingId, {
            orderId,
            groupKey: groupKeyByBookingId.get(bookingId),
            cleanupOrphans: true,
            afterProjection: async (removed) => {
              const groupKey = removed?.groupKey || groupKeyByBookingId.get(bookingId);
              if (groupKey) {
                await store.removeConfirmedBookingByGroupKey(groupKey, { shop, orderId });
              } else if (durableBookings) {
                throw new Error("Booking capacity identity unavailable");
              }
            },
          });
          const groupKey = record?.groupKey || groupKeyByBookingId.get(bookingId);
          const recordContext = record
            ? {
                productId: record.productId,
                travelDate: record.travelDate,
                poolKey: record.poolKey,
              }
            : { productId: null, travelDate: null, poolKey: null };
          logEvent(
            "webhook.orders_cancelled",
            {
              orderId,
              groupKey: groupKey || null,
              bookingId,
              ...recordContext,
              action: "delete",
            },
            { correlationId, shop, severity: "info" },
          );
        }
      }
    }

    // 6. 성공 응답 (200)
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
          message: "Orders cancelled webhook processing error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

    // 500 반환 (Shopify 재시도 유도)
    return new Response("Internal server error", { status: 500 });
  }
};
