import type { LoaderFunctionArgs } from "react-router";
import { getStorefrontViewerCatalog } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/domains/storefront/customerProxy.server.ts";

/**
 * GET /proxy/bta/mypage/viewer
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "legacy",
  });
  if (context instanceof Response) {
    return context;
  }

  const data = await getStorefrontViewerCatalog(request, context.customerId);
  return respond.ok(data, { correlationId: context.correlationId });
};
