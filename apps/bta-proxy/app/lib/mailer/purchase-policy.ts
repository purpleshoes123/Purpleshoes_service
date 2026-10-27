import { z } from 'zod';
import { extractBaseTypeFromVariantId } from '~/lib/guideExtension/baseLineItems';

export function getPurchaseEmailConfig(env: Record<string, string | undefined> = process.env) {
  if (env.PURCHASE_EMAIL_ENABLED !== 'true') return null;
  const shop = env.PURCHASE_EMAIL_SHOP?.trim().toLowerCase() || '';
  const cutover = new Date(env.PURCHASE_EMAIL_CUTOVER_AT || '');
  if (env.PURCHASE_EMAIL_LEGACY_FLOWS_DISABLED !== 'true' ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
      !Number.isFinite(cutover.getTime()) ||
      !/(Z|[+-]\d\d:\d\d)$/.test(env.PURCHASE_EMAIL_CUTOVER_AT || '') ||
      !env.GUIDE_BASE_VARIANT_ID_PDF || !env.GUIDE_BASE_VARIANT_ID_VIDEO || !env.GUIDE_BASE_VARIANT_ID_BUNDLE) {
    throw new Error('Purchase email cutover configuration is incomplete');
  }
  return { shop, cutover, allowTestOrders: env.PURCHASE_EMAIL_ALLOW_TEST_ORDERS === 'true' };
}

const id = z.union([z.string().regex(/^\d+$/), z.number().int().positive().safe()]);
const orderSchema = z.object({
  id,
  financial_status: z.string(),
  cancelled_at: z.string().nullable().optional(),
  test: z.boolean().optional(),
  processed_at: z.string().nullable().optional(),
  created_at: z.string(),
  line_items: z.array(z.object({ variant_id: id.nullable().optional(), quantity: z.number().int().nonnegative() })),
});

export function purchaseEmailCandidate(payload: unknown, shop: string, config: NonNullable<ReturnType<typeof getPurchaseEmailConfig>>) {
  if (shop.toLowerCase() !== config.shop) throw new Error('Unexpected purchase email shop');
  const order = orderSchema.parse(payload);
  if (order.financial_status !== 'paid' || order.cancelled_at || (order.test && !config.allowTestOrders)) return null;
  const paidAt = new Date(order.processed_at || order.created_at);
  if (!Number.isFinite(paidAt.getTime())) throw new Error('Invalid purchase date');
  if (paidAt < config.cutover) return null; // No accidental historical customer blast.
  const types = [...new Set(order.line_items.filter(line => line.quantity > 0)
    .map(line => extractBaseTypeFromVariantId(line.variant_id)).filter((type): type is 'PDF' | 'VIDEO' | 'BUNDLE' => Boolean(type)))].sort();
  if (!types.length) return null; // No tour/extension/unrelated-product marketing.
  const bundle = types.includes('BUNDLE');
  return { orderId: String(order.id), kind: bundle ? 'GUIDE_KIT' : 'GUIDE_ONLY',
    entitlementTypes: JSON.stringify(bundle ? ['BUNDLE'] : types) };
}
