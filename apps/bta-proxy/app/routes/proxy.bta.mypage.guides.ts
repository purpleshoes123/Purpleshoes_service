import type { LoaderFunctionArgs } from "react-router";
import { listStorefrontGuides } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/domains/storefront/customerProxy.server.ts";

/**
 * GET /proxy/bta/mypage/guides
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "legacy",
  });
  if (context instanceof Response) {
    return context;
  }

  const data = await listStorefrontGuides(request, context.customerId);
  return respond.ok(data, { correlationId: context.correlationId });
};
