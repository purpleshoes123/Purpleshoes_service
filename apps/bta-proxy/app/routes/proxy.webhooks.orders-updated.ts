import type { ActionFunctionArgs } from "react-router";
import { verifyWebhook } from "~/middleware/verifyWebhook";
import {
  saveWebhookEvent,
  updateWebhookEventEvaluation,
  updateWebhookEventOrderId,
} from "~/lib/webhookEventStore";
import { normalizeTerminalStatus } from "~/lib/webhookVoidNormalizer";
import { extractHoldMapping } from "~/lib/webhookHoldMapping";
import { executeHoldRelease } from "~/lib/webhookHoldRelease";
import { createHash, randomUUID } from "crypto";
import { extractBookingInfoFromLineItem } from "~/lib/webhookUtils";
import { groupLineItemsByBooking } from "~/lib/webhookGrouping";
import { fetchOrderLineItemsGraphQL, getAdminApiClient } from "~/lib/shopifyAdmin";
import { upsertOrderBookingIdMetafield } from "~/lib/orderMetafieldService";
import {
  addFixedMonthDaysKstEndOfDay,
  appendLedgerEvent,
  buildBaseEventHandle,
  createLog,
  extractBaseLineItems,
  fetchOrderCustomerId,
  fetchVariantAccessMonths,
  getBaseDefaultMonths,
  getCustomerEntitlements,
  listLedgerEvents,
  normalizeToKstEndOfDay,
  recomputeEntitlement,
  revokeGuideBaseEntitlementsForOrder,
  setCustomerEntitlementExpiresAt,
  type EntitlementType,
} from "~/lib/guideExtension";
import db from "~/db.server";

/**
 * SSOT 15.1: POST /proxy/webhooks/orders-updated
 * SSOT 15.2: Webhook HMAC 검증 (raw body 기반)
 * Phase 2/3: Void 세컨더리 방어선
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. HMAC 검증
  const verification = await verifyWebhook(request);
  if (!verification.verified) {
    return verification.response;
  }

  const rawBody = verification.rawBody;
  const correlationId =
    request.headers.get("X-Request-Id") ||
    request.headers.get("X-Correlation-Id") ||
    randomUUID();

  // Phase 1: Webhook 이벤트 저장 (멱등성 보장)
  const topic = request.headers.get("X-Shopify-Topic") || "orders/updated";
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");

  let eventResult: Awaited<ReturnType<typeof saveWebhookEvent>> | null = null;
  try {
    eventResult = await saveWebhookEvent(topic, rawBody, null, webhookId);

    console.log(
      JSON.stringify({
        message: "Webhook event saved",
        topic,
        eventKey: eventResult.eventKey,
        isDuplicate: eventResult.isDuplicate,
        correlationId,
      })
    );

    if (eventResult.isDuplicate) {
      return new Response("OK", { status: 200 });
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Failed to save webhook event, continuing with business logic",
        topic,
        error: error instanceof Error ? error.message : String(error),
        correlationId,
      })
    );
  }

  try {
    // 2. JSON 파싱
    const payload = JSON.parse(rawBody) as {
      id?: number;
      order_number?: number;
      customer?: { id?: number | string } | null;
      financial_status?: string;
      cancelled_at?: string | null;
      transactions?: Array<Record<string, unknown>>;
      line_items?: Array<{
        id?: number;
        product_id?: number;
        variant_id?: number;
        sku?: string | null;
        quantity?: number;
        properties?: Array<{ name: string; value: string }>;
      }>;
      note_attributes?: Array<{ name: string; value: string }>;
      processed_at?: string | null;
      created_at?: string | null;
      [key: string]: unknown;
    };

    // 3. shop 추출
    const shop =
      request.headers.get("X-Shopify-Shop-Domain") ||
      (payload as any).shop ||
      "";

    if (!shop) {
      console.error(
        JSON.stringify({
          message: "Missing shop information in webhook",
        })
      );
      return new Response("Missing shop information", { status: 400 });
    }

    const orderId = payload.id?.toString() || payload.order_number?.toString();
    if (!orderId) {
      console.error(
        JSON.stringify({
          message: "Missing order ID in webhook payload",
        })
      );
      return new Response("Missing order ID", { status: 400 });
    }

    const lineItems = payload.line_items || [];

    if (eventResult && !eventResult.isDuplicate) {
      try {
        await updateWebhookEventOrderId(eventResult.eventKey, orderId);
      } catch (error) {
        // 업데이트 실패는 무시
      }
    }

    try {
      if (lineItems.length > 0) {
        const groups = await groupLineItemsByBooking(
          lineItems,
          extractBookingInfoFromLineItem,
          shop
        );
        if (groups.length === 1) {
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
                JSON.stringify({
                  message: "Order booking_id sync failed (orders/updated)",
                  orderId,
                  bookingId,
                  error: metaResult.message,
                })
              );
            }
          } else {
            console.warn(
              JSON.stringify({
                message: "Order booking_id sync skipped (admin unavailable)",
                orderId,
                bookingId,
              })
            );
          }
        } else if (groups.length > 1) {
          console.warn(
            JSON.stringify({
              message: "Order booking_id sync skipped (multiple groups)",
              orderId,
              groupCount: groups.length,
            })
          );
        }
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Order booking_id sync error (orders/updated)",
          orderId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }

    const terminalStatus = normalizeTerminalStatus({ topic, payload });
    const isPaid =
      payload.financial_status === "paid" && !payload.cancelled_at;
    if (isPaid) {
      let guideLineItems = lineItems;
      let baseLineItems = extractBaseLineItems(guideLineItems);
      if (baseLineItems.length === 0) {
        const adminFallback = await getAdminApiClient(shop);
        if (adminFallback) {
          try {
            const adminLineItems = await fetchOrderLineItemsGraphQL(
              adminFallback,
              orderId
            );
            if (adminLineItems.length > 0) {
              guideLineItems = adminLineItems;
              baseLineItems = extractBaseLineItems(guideLineItems);
            }
          } catch (error) {
            if (process.env.DEBUG_BOOKING === "1") {
              console.warn(
                JSON.stringify({
                  message: "Guide line_items fallback failed",
                  orderId,
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
          }
        }
      }

      if (process.env.DEBUG_BOOKING === "1" && baseLineItems.length === 0) {
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
          })
        );
      }
      if (baseLineItems.length > 0) {
        try {
          const admin = await getAdminApiClient(shop);
          if (!admin) {
            console.warn(
              JSON.stringify({
                message: "Guide base skipped (admin unavailable)",
                orderId,
              })
            );
          } else {
            const customerId = await fetchOrderCustomerId(admin, orderId);
            if (!customerId) {
              console.warn(
                JSON.stringify({
                  message: "Guide base skipped (missing customerId)",
                  orderId,
                })
              );
            } else {
              const customerGid = customerId.startsWith("gid://")
                ? customerId
                : `gid://shopify/Customer/${customerId}`;
              const occurredAt =
                payload.processed_at ||
                payload.created_at ||
                new Date().toISOString();
              const entitlements = await getCustomerEntitlements(
                admin,
                customerGid
              );

              const uniqueByType = new Map<
                EntitlementType,
                (typeof baseLineItems)[number]
              >();
              for (const item of baseLineItems) {
                if (uniqueByType.has(item.type)) {
                  console.warn(
                    JSON.stringify({
                      message: "Guide base duplicate line item skipped",
                      orderId,
                      type: item.type,
                    })
                  );
                  continue;
                }
                uniqueByType.set(item.type, item);
              }

              const toTimestamp = (value?: string | null): number | null => {
                if (!value) return null;
                const date = new Date(value);
                if (Number.isNaN(date.getTime())) return null;
                return date.getTime();
              };

              const getLatestTimestamp = (
                records: Array<{ occurredAt?: string | null }>
              ): number | null => {
                let latest: number | null = null;
                for (const record of records) {
                  const ts = toTimestamp(record.occurredAt);
                  if (ts === null) continue;
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
                  baseEvents = events.filter(
                    (event) => event.eventType === "BASE"
                  );
                  baseForOrder = baseEvents.some(
                    (event) => event.orderId === orderId
                  );
                  const refundEvents = events.filter(
                    (event) =>
                      event.eventType === "REFUND" &&
                      typeof event.note === "string" &&
                      event.note.includes("base_refund=true")
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
                    topic: "orders/updated",
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
                      reason: "orders/updated base sync",
                    });
                    await createLog(db, {
                      shop,
                      topic: "orders/updated",
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
                    await createLog(db, {
                      shop,
                      topic: "orders/updated",
                      customerId: customerGid,
                      entitlementType: type,
                      eventType: "BASE_SYNC",
                      monthsDelta: 0,
                      orderId,
                      status: "FAILED",
                      errorCode: "GUIDE_EXTENSION_WEBHOOK_ERROR",
                      errorMessage:
                        error instanceof Error ? error.message : String(error),
                      rawRef: eventResult?.eventKey || undefined,
                    });
                  }
                  continue;
                }

                let months: number | null = null;
                if (item.variantId !== null && item.variantId !== undefined) {
                  try {
                    months = await fetchVariantAccessMonths(
                      admin,
                      item.variantId
                    );
                  } catch (error) {
                    console.warn(
                      JSON.stringify({
                        message: "Guide base months lookup failed",
                        orderId,
                        type,
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      })
                    );
                  }
                }
                if (!months) {
                  months = getBaseDefaultMonths(type);
                }

                const baseExpiresAt = addFixedMonthDaysKstEndOfDay(
                  normalizeToKstEndOfDay(occurredAt),
                  months
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

                await setCustomerEntitlementExpiresAt(
                  admin,
                  customerGid,
                  type,
                  baseExpiresAt
                );

                await createLog(db, {
                  shop,
                  topic: "orders/updated",
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
          console.error(
            JSON.stringify({
              message: "Guide base processing error",
              orderId,
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      }
    } else if (terminalStatus === "TERMINAL_FAIL_RELEASE") {
      try {
        let guideLineItems = lineItems;
        let baseLineItems = extractBaseLineItems(guideLineItems);
        let lineItemsSource: "payload" | "admin" = "payload";
        const admin = await getAdminApiClient(shop);

        if (baseLineItems.length === 0 && admin) {
          try {
            const adminLineItems = await fetchOrderLineItemsGraphQL(
              admin,
              orderId
            );
            if (adminLineItems.length > 0) {
              guideLineItems = adminLineItems;
              baseLineItems = extractBaseLineItems(guideLineItems);
              lineItemsSource = "admin";
            }
          } catch (error) {
            console.warn(
              JSON.stringify({
                message: "Guide base terminal update line item fallback failed",
                orderId,
                terminalStatus,
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
        }

        if (baseLineItems.length > 0) {
          if (!admin) {
            console.warn(
              JSON.stringify({
                message: "Guide base terminal update skipped (admin unavailable)",
                orderId,
                terminalStatus,
                lineItemsSource,
              })
            );
          } else {
            const payloadCustomerId = payload.customer?.id?.toString() || null;
            const customerId = payloadCustomerId || (await fetchOrderCustomerId(admin, orderId));
            if (!customerId) {
              console.warn(
                JSON.stringify({
                  message: "Guide base terminal update skipped (missing customerId)",
                  orderId,
                  terminalStatus,
                  lineItemsSource,
                })
              );
            } else {
              const revokeResult = await revokeGuideBaseEntitlementsForOrder({
                admin,
                shop,
                topic: "orders/updated",
                customerId,
                orderId,
                lineItems: baseLineItems,
                occurredAt:
                  payload.cancelled_at ||
                  payload.processed_at ||
                  payload.created_at ||
                  new Date().toISOString(),
                rawRef: eventResult?.eventKey || undefined,
              });
              if (revokeResult.failed.length > 0 || revokeResult.skipped.length > 0) {
                console.warn(
                  JSON.stringify({
                    message: "Guide base terminal update revoke completed with warnings",
                    orderId,
                    terminalStatus,
                    lineItemsSource,
                    revoked: revokeResult.revoked,
                    skipped: revokeResult.skipped,
                    failed: revokeResult.failed,
                  })
                );
              }
            }
          }
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "Guide base terminal update processing error",
            orderId,
            terminalStatus,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }

    const pipelineEnabled =
      process.env.HOLD_RELEASE_VOID_PIPELINE_ENABLED === "true";
    const dryrun = process.env.HOLD_RELEASE_VOID_DRYRUN !== "false";

    if (pipelineEnabled && eventResult && !eventResult.isDuplicate) {
      try {
        const normalizedStatus = terminalStatus;
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
          })
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
          })
        );
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Orders updated webhook processing error",
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return new Response("Internal server error", { status: 500 });
  }
};
