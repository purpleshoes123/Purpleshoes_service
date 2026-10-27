import type { LoaderFunctionArgs } from "react-router";
import { getStorefrontViewerCatalog } from "~/lib/gkv/storefrontViewer.server";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/lib/storefront/customerProxy.server";

/**
 * GET /proxy/bta/mypage/viewer
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "legacy",
  });
  if (context instanceof Response) return context;

  const data = await getStorefrontViewerCatalog(request, context.customerId);
  return respond.ok(data, { correlationId: context.correlationId });
};
