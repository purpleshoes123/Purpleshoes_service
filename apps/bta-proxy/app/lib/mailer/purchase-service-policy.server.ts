import { z } from 'zod';
import { extractExtensionTypeFromVariantId } from '~/lib/guideExtension/extensionProduct';
import { groupLineItemsByBooking } from '~/lib/webhookGrouping';
import { extractBookingInfoFromLineItem } from '~/lib/webhookUtils';

export function getPurchaseServiceEmailCutover(env: Record<string, string | undefined> = process.env) {
  if (env.PURCHASE_SERVICE_EMAIL_ENABLED !== 'true') return null;
  const raw = env.PURCHASE_SERVICE_EMAIL_CUTOVER_AT || '';
  const cutover = new Date(raw);
  if (env.PURCHASE_SERVICE_EMAIL_LEGACY_FLOWS_DISABLED !== 'true' ||
      !['postgres', 'redis'].includes(env.BOOKING_STORE_TYPE || '') ||
      (env.BOOKING_STORE_TYPE === 'redis' && !env.REDIS_URL) || !/(Z|[+-]\d\d:\d\d)$/.test(raw) ||
      !Number.isFinite(cutover.getTime()) || !env.GUIDE_EXT_VARIANT_ID_PDF ||
      !env.GUIDE_EXT_VARIANT_ID_VIDEO || !env.GUIDE_EXT_VARIANT_ID_BUNDLE) {
    throw new Error('Service purchase email cutover configuration is incomplete');
  }
  return cutover;
}

const id = z.union([z.string().regex(/^\d+$/), z.number().int().positive().safe()]);
const orderSchema = z.object({
  id, financial_status: z.string(), cancelled_at: z.string().nullable().optional(),
  test: z.boolean().optional(), processed_at: z.string().nullable().optional(), created_at: z.string(),
  line_items: z.array(z.object({
    id, variant_id: id.nullable().optional(), product_id: id.optional(), quantity: z.number().int().nonnegative(),
    properties: z.array(z.object({ name: z.string(), value: z.string().nullable() })).optional(),
  }).passthrough()),
});

// One receipt per order/category, not per ticket, quantity, webhook or customer.
// The second cutover deliberately excludes old tour/extension orders handled by Flow.
export async function purchaseServiceEmailCandidates(payload: unknown, shop: string, allowTestOrders: boolean) {
  const cutover = getPurchaseServiceEmailCutover();
  if (!cutover) return [];
  const order = orderSchema.parse(payload);
  if (order.financial_status !== 'paid' || order.cancelled_at || (order.test && !allowTestOrders)) return [];
  const paidAt = new Date(order.processed_at || order.created_at);
  if (!Number.isFinite(paidAt.getTime())) throw new Error('Invalid service purchase date');
  if (paidAt < cutover) return [];
  const lines = order.line_items.filter(line => line.quantity > 0).map(line => ({ ...line,
    variant_id: line.variant_id ?? undefined,
    properties: line.properties?.map(property => ({ ...property, value: property.value ?? '' })),
  }));
  const candidates: Array<{ orderId: string; kind: string; entitlementTypes: string }> = [];
  const types = [...new Set(lines.map(line => extractExtensionTypeFromVariantId(line.variant_id)).filter(Boolean))].sort();
  if (types.length) candidates.push({ orderId: String(order.id), kind: 'GUIDE_EXTENSION', entitlementTypes: JSON.stringify(types) });
  // Use the exact same group resolver as booking confirmation, including policy fallback.
  const groups = await groupLineItemsByBooking(lines, extractBookingInfoFromLineItem, shop);
  if (groups.length) candidates.push({ orderId: String(order.id), kind: 'TOUR',
    entitlementTypes: JSON.stringify({ bookingGroupKeys: groups.map(group => group.groupKey).sort() }) });
  return candidates;
}
