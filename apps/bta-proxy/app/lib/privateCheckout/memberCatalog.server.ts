import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { normalizeGuideVariantId } from "~/lib/guideExtension/baseLineItems";
import { getCouponRulesConfig } from "~/lib/coupons/config";
import type { SummaryDTO } from "~/lib/couponDisplay/types";

export const MEMBER_GUIDE_QUERY = `#graphql
  query MemberGuideCatalog($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      ... on ProductVariant { id title price product { status } }
    }
  }
`;

type Variant = { id: string; title: string; price: string; product: { status: string } };

export async function readMemberGuideCatalog(admin: AdminApiContext, summary: SummaryDTO) {
  const plans = (["PDF", "BUNDLE", "VIDEO"] as const).map(kind => {
    const id = normalizeGuideVariantId(process.env[`GUIDE_BASE_VARIANT_ID_${kind}`]);
    if (!id || !/^[1-9]\d*$/.test(id)) throw new Error("Guide catalog is not configured");
    return { kind, id: `gid://shopify/ProductVariant/${id}` };
  });
  const response = await admin.graphql(MEMBER_GUIDE_QUERY, { variables: { ids: plans.map(p => p.id) } });
  const result = await response.json() as {
    errors?: unknown[];
    data?: { shop: { currencyCode: string }; nodes: Array<Variant | null> };
  };
  if (!response.ok || result.errors?.length || !result.data) throw new Error("Guide catalog unavailable");
  const { currencyCode: currency } = result.data.shop;
  // Current coupon rules are USD-only. Never display a fabricated FX discount.
  if (currency !== summary.currency) throw new Error("Guide currency does not match coupon rules");
  const eligibleBundles = getCouponRulesConfig().guideKitVariantIds;
  return {
    kind: "guide",
    currency,
    plans: plans.map(plan => {
      const variant = result.data!.nodes.find(v => v?.id === plan.id);
      if (!variant || variant.product.status !== "ACTIVE" || !/^\d+(\.\d{1,2})?$/.test(variant.price)) {
        throw new Error("Guide plan unavailable");
      }
      const priceCents = Math.round(Number(variant.price) * 100);
      const percent = summary.coupons.guide50.available && eligibleBundles.has(plan.id.split("/").pop()!)
        ? summary.coupons.guide50.percentRate : 0;
      const afterPercent = Math.round(priceCents * (1 - percent));
      const extraCents = summary.coupons.extra10.available ? Math.round(summary.coupons.extra10.amount * 100) : 0;
      return {
        kind: plan.kind, variantId: plan.id, title: variant.title,
        priceCents, memberPriceCents: Math.max(0, afterPercent),
        extraPriceCents: Math.max(0, afterPercent - extraCents),
        extraAvailable: summary.coupons.extra10.available,
      };
    }),
  };
}

// Only the production tour approved for public introduction. Never look up
// arbitrary draft/test products from a caller-provided handle or product ID.
export const MEMBER_TOURS: Readonly<Record<string, string>> = {
  "a-day-outside-seoul": "7634763382878",
};
