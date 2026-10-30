import type { LoaderFunctionArgs } from "react-router";
import { listStorefrontCategories } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/domains/storefront/customerProxy.server.ts";

/**
 * GET /proxy/bta/mypage/categories
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "customer",
    rateLimitBucket: "mypage-read",
  });
  if (context instanceof Response) {
    return context;
  }

  const data = await listStorefrontCategories(request, context.customerId);
  return respond.ok(data, { correlationId: context.correlationId });
};
