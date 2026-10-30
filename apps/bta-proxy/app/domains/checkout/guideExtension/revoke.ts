import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "~/db.server.ts";
import type { BaseLineItemMatch } from "./baseLineItems";
import { fetchVariantAccessMonths, getBaseDefaultMonths } from "./baseLineItems";
import { getCustomerEntitlements, type CustomerEntitlements } from "./customerMetafields";
import { appendLedgerEvent } from "./ledger";
import { createLog } from "./logStore";
import { recomputeEntitlement } from "./recompute";
import type { EntitlementType } from "./types";

export type GuideBaseRevokeTopic = "refunds/create" | "orders/cancelled" | "orders/updated";

export type GuideBaseRevokeResult = {
  revoked: Array<{
    type: EntitlementType;
    previousExpiresAt: string | null;
    newExpiresAt: string | null;
    legacyRevokedCount: number;
  }>;
  skipped: Array<{
    type: EntitlementType;
    reason: string;
  }>;
  failed: Array<{
    type: EntitlementType;
    error: string;
  }>;
};

function normalizeCustomerGid(customerId: string): string {
  return customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`;
}

function toHandleSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeOrderId(orderId?: string | null): string | null {
  if (!orderId) {
    return null;
  }
  const raw = String(orderId).trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    return parts[parts.length - 1] || null;
  }
  return raw;
}

function buildBaseRefundEventHandle(
  customerId: string,
  type: EntitlementType,
  orderId: string,
): string {
  const gid = normalizeCustomerGid(customerId);
  const match = gid.match(/\/Customer\/(\d+)$/);
  const customerSegment = match ? match[1] : toHandleSegment(gid);
  const orderSegment = toHandleSegment(normalizeOrderId(orderId) || orderId);
  return `base-refund-${type.toLowerCase()}-${customerSegment}-${orderSegment}`;
}

function orderIdCandidates(orderId: string): string[] {
  const normalized = normalizeOrderId(orderId);
  const candidates = new Set<string>();
  if (orderId) {
    candidates.add(orderId);
  }
  if (normalized) {
    candidates.add(normalized);
    candidates.add(`gid://shopify/Order/${normalized}`);
  }
  return Array.from(candidates);
}

function customerIdCandidates(customerId: string): string[] {
  const gid = normalizeCustomerGid(customerId);
  const candidates = new Set<string>([customerId, gid]);
  const match = gid.match(/\/Customer\/(\d+)$/);
  if (match?.[1]) {
    candidates.add(match[1]);
  }
  return Array.from(candidates);
}

async function resolveBaseAccessMonths(
  admin: AdminApiContext,
  item: BaseLineItemMatch,
): Promise<number> {
  if (item.variantId !== null && item.variantId !== undefined) {
    try {
      const months = await fetchVariantAccessMonths(admin, item.variantId);
      if (months) {
        return months;
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Guide base revoke months lookup failed",
          type: item.type,
          variantId: item.variantId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return getBaseDefaultMonths(item.type);
}

export async function revokeGuideBaseEntitlementsForOrder(params: {
  admin: AdminApiContext;
  shop: string;
  topic: GuideBaseRevokeTopic;
  customerId: string;
  orderId: string;
  lineItems: BaseLineItemMatch[];
  refundId?: string | null;
  occurredAt: string;
  rawRef?: string | null;
}): Promise<GuideBaseRevokeResult> {
  const result: GuideBaseRevokeResult = { revoked: [], skipped: [], failed: [] };
  const customerGid = normalizeCustomerGid(params.customerId);
  const entitlements = await getCustomerEntitlements(params.admin, customerGid).catch((error) => {
    console.warn(
      JSON.stringify({
        message: "Guide base revoke previous entitlement lookup failed",
        orderId: params.orderId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {} as CustomerEntitlements;
  });

  const uniqueByType = new Map<EntitlementType, BaseLineItemMatch>();
  for (const item of params.lineItems) {
    if (uniqueByType.has(item.type)) {
      result.skipped.push({ type: item.type, reason: "DUPLICATE_LINE_ITEM_TYPE" });
      continue;
    }
    uniqueByType.set(item.type, item);
  }

  for (const [type, item] of uniqueByType.entries()) {
    const previousValue = entitlements[type] ?? null;
    const months = await resolveBaseAccessMonths(params.admin, item);
    const note =
      `order_id=${params.orderId}|refund_id=${params.refundId || "unknown"}` +
      `|base_refund=true|months=${months}|source_topic=${params.topic}`;

    try {
      const appended = await appendLedgerEvent(params.admin, {
        customerId: customerGid,
        entitlementType: type,
        eventType: "REFUND",
        months,
        orderId: params.orderId,
        lineItemId: item.lineItemId,
        refundId: params.refundId || undefined,
        occurredAt: params.occurredAt,
        handle: buildBaseRefundEventHandle(customerGid, type, params.orderId),
        note,
      });

      let baseExpiresAt: string | null = null;
      let newExpiresAt: string | null = null;
      const recomputeResult = await recomputeEntitlement({
        admin: params.admin,
        customerId: customerGid,
        type,
        reason: params.topic,
        additionalEvents: [
          {
            id: appended.id,
            entitlementType: type,
            eventType: "REFUND",
            months,
            occurredAt: params.occurredAt,
            orderId: params.orderId,
            lineItemId: item.lineItemId,
            refundId: params.refundId || undefined,
            note,
          },
        ],
      });
      baseExpiresAt = recomputeResult.baseExpiresAt;
      newExpiresAt = recomputeResult.newExpiresAt;

      const customerCandidates = customerIdCandidates(customerGid);
      const orderCandidates = orderIdCandidates(params.orderId);
      const legacyResult = await prisma.gkvEntitlement.updateMany({
        where: {
          status: "ACTIVE",
          OR: customerCandidates.flatMap((customerId) =>
            orderCandidates.map((sourceOrderId) => ({ customerId, sourceOrderId })),
          ),
        },
        data: { status: "REVOKED" },
      });

      await createLog(prisma, {
        shop: params.shop,
        topic: params.topic,
        customerId: customerGid,
        entitlementType: type,
        eventType: "BASE_REFUND",
        monthsDelta: -months,
        orderId: params.orderId,
        refundId: params.refundId || undefined,
        baseExpiresAt,
        previousExpiresAt: previousValue,
        newExpiresAt,
        status: "SUCCESS",
        rawRef: params.rawRef || undefined,
      });

      result.revoked.push({
        type,
        previousExpiresAt: previousValue,
        newExpiresAt,
        legacyRevokedCount: legacyResult.count,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ type, error: message });
      try {
        await createLog(prisma, {
          shop: params.shop,
          topic: params.topic,
          customerId: customerGid,
          entitlementType: type,
          eventType: "BASE_REFUND",
          monthsDelta: -months,
          orderId: params.orderId,
          refundId: params.refundId || undefined,
          status: "FAILED",
          errorCode: "GUIDE_BASE_REVOKE_ERROR",
          errorMessage: message,
          rawRef: params.rawRef || undefined,
        });
      } catch (logError) {
        console.error(
          JSON.stringify({
            message: "Guide base revoke failure log insert failed",
            orderId: params.orderId,
            type,
            error: logError instanceof Error ? logError.message : String(logError),
          }),
        );
      }
    }
  }

  return result;
}
