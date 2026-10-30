import { createHash } from "crypto";
import {
  extractBaseTypeFromVariantId,
  getBaseDefaultMonths,
} from "~/domains/checkout/guideExtension/baseLineItems";
import {
  extractExtensionTypeFromVariantId,
  extractMonthsFromQuantity,
} from "~/domains/checkout/guideExtension/extensionProduct";
import type { EntitlementType } from "~/domains/checkout/guideExtension/types";
import type { GroupedLineItems } from "~/domains/webhooks/webhookGrouping";
import { extractTravelersFromLineItems } from "~/domains/webhooks/webhookTravelers";
import type {
  KlaviyoPurchaseEventKind,
  KlaviyoPurchaseEventOption,
  KlaviyoPurchaseEventProperties,
} from "./purchaseEvents.server.ts";

type LineItemLike = {
  id?: string | number | null;
  product_id?: string | number | null;
  variant_id?: string | number | null;
  sku?: string | null;
  quantity?: number | null;
  properties?: Array<{ name: string; value: string }>;
};

export type KlaviyoPurchaseEventCandidate = {
  metricName: string;
  uniqueId: string;
  eventKind: KlaviyoPurchaseEventKind;
  option: KlaviyoPurchaseEventOption;
  properties: KlaviyoPurchaseEventProperties;
};

type CandidateParams = {
  shop: string;
  orderId: string;
  orderNumber?: string | number | null;
  guideLineItems: LineItemLike[];
  bookingGroups: GroupedLineItems[];
};

const TYPE_ORDER: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];

function stringifyId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  return raw || null;
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((v) => stringifyId(v)).filter(Boolean) as string[]));
}

function mapBaseOption(type: EntitlementType): KlaviyoPurchaseEventOption {
  return type === "BUNDLE" ? "GUIDE-KIT" : type;
}

function mapExtensionOption(type: EntitlementType): KlaviyoPurchaseEventOption {
  if (type === "BUNDLE") {
    return "GUIDE-KIT-EX";
  }
  return `${type}-EX` as KlaviyoPurchaseEventOption;
}

function mapBaseMetric(type: EntitlementType): string {
  if (type === "PDF") {
    return "BTA Guide PDF Purchased";
  }
  if (type === "VIDEO") {
    return "BTA Guide Video Purchased";
  }
  return "BTA Guide Kit Purchased";
}

function mapExtensionMetric(type: EntitlementType): string {
  if (type === "PDF") {
    return "BTA Guide PDF Extension Purchased";
  }
  if (type === "VIDEO") {
    return "BTA Guide Video Extension Purchased";
  }
  return "BTA Guide Kit Extension Purchased";
}

function buildCommonProperties(params: CandidateParams) {
  return {
    shop_domain: params.shop,
    order_id: params.orderId,
    order_number: stringifyId(params.orderNumber),
  };
}

function groupKeyHash(groupKey: string): string {
  return createHash("sha256").update(groupKey).digest("hex").slice(0, 16);
}

function buildBaseCandidates(params: CandidateParams): KlaviyoPurchaseEventCandidate[] {
  const byType = new Map<EntitlementType, LineItemLike[]>();
  for (const lineItem of params.guideLineItems) {
    const type = extractBaseTypeFromVariantId(lineItem.variant_id ?? null);
    if (!type) {
      continue;
    }
    const lines = byType.get(type) || [];
    lines.push(lineItem);
    byType.set(type, lines);
  }

  const candidates: KlaviyoPurchaseEventCandidate[] = [];
  for (const type of TYPE_ORDER) {
    const lines = byType.get(type);
    if (!lines || lines.length === 0) {
      continue;
    }
    const totalQuantity = lines.reduce(
      (sum, line) => sum + Math.max(0, Math.trunc(line.quantity ?? 1)),
      0,
    );
    candidates.push({
      metricName: mapBaseMetric(type),
      uniqueId: `bta-purchase:guide-base:${params.orderId}:${type}`,
      eventKind: "GUIDE_BASE",
      option: mapBaseOption(type),
      properties: {
        ...buildCommonProperties(params),
        entitlement_type: type,
        line_item_count: lines.length,
        total_quantity: totalQuantity,
        default_base_months: getBaseDefaultMonths(type),
        line_item_ids: uniqueValues(lines.map((line) => stringifyId(line.id))),
        product_ids: uniqueValues(lines.map((line) => stringifyId(line.product_id))),
        variant_ids: uniqueValues(lines.map((line) => stringifyId(line.variant_id))),
        skus: uniqueValues(lines.map((line) => line.sku)),
      },
    });
  }
  return candidates;
}

function buildExtensionCandidates(params: CandidateParams): KlaviyoPurchaseEventCandidate[] {
  const byType = new Map<EntitlementType, { lines: LineItemLike[]; months: number }>();
  for (const lineItem of params.guideLineItems) {
    const type = extractExtensionTypeFromVariantId(lineItem.variant_id ?? null);
    if (!type) {
      continue;
    }
    const months = extractMonthsFromQuantity(lineItem.quantity ?? null);
    if (!months) {
      continue;
    }
    const current = byType.get(type) || { lines: [], months: 0 };
    current.lines.push(lineItem);
    current.months += months;
    byType.set(type, current);
  }

  const candidates: KlaviyoPurchaseEventCandidate[] = [];
  for (const type of TYPE_ORDER) {
    const entry = byType.get(type);
    if (!entry) {
      continue;
    }
    const totalQuantity = entry.lines.reduce(
      (sum, line) => sum + Math.max(0, Math.trunc(line.quantity ?? 1)),
      0,
    );
    candidates.push({
      metricName: mapExtensionMetric(type),
      uniqueId: `bta-purchase:guide-extension:${params.orderId}:${type}`,
      eventKind: "GUIDE_EXTENSION",
      option: mapExtensionOption(type),
      properties: {
        ...buildCommonProperties(params),
        entitlement_type: type,
        months: entry.months,
        line_item_count: entry.lines.length,
        total_quantity: totalQuantity,
        line_item_ids: uniqueValues(entry.lines.map((line) => stringifyId(line.id))),
        product_ids: uniqueValues(entry.lines.map((line) => stringifyId(line.product_id))),
        variant_ids: uniqueValues(entry.lines.map((line) => stringifyId(line.variant_id))),
        skus: uniqueValues(entry.lines.map((line) => line.sku)),
      },
    });
  }
  return candidates;
}

function buildTourCandidates(params: CandidateParams): KlaviyoPurchaseEventCandidate[] {
  return params.bookingGroups.map((group) => {
    const travelers = extractTravelersFromLineItems(group.lineItems);
    return {
      metricName: "BTA Tour Purchased",
      uniqueId: `bta-purchase:tour:${params.orderId}:${groupKeyHash(group.groupKey)}`,
      eventKind: "TOUR" as const,
      option: "TOUR" as const,
      properties: {
        ...buildCommonProperties(params),
        group_key: group.groupKey,
        group_key_hash: groupKeyHash(group.groupKey),
        travel_date: group.bookingInfo.travelDate,
        product_id: group.bookingInfo.productId,
        booking_mode: group.bookingInfo.bookingMode,
        pool_key: group.bookingInfo.poolKey,
        guide_units_required: group.bookingInfo.guideUnitsRequired,
        party_size: group.bookingInfo.partySize,
        line_item_count: group.lineItems.length,
        line_item_ids: uniqueValues(group.lineItems.map((line) => stringifyId(line.id))),
        variant_ids: uniqueValues(group.lineItems.map((line) => stringifyId(line.variant_id))),
        adult: travelers?.adult ?? null,
        child: travelers?.child ?? null,
        infant: travelers?.infant ?? null,
      },
    };
  });
}

export function buildKlaviyoPurchaseEventCandidates(
  params: CandidateParams,
): KlaviyoPurchaseEventCandidate[] {
  return [
    ...buildBaseCandidates(params),
    ...buildExtensionCandidates(params),
    ...buildTourCandidates(params),
  ];
}
