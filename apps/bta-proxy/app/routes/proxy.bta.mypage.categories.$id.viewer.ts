import type { LoaderFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getStorefrontCategoryAvailability } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/domains/storefront/customerProxy.server.ts";

/**
 * GET /proxy/bta/mypage/categories/:id/viewer
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "customer",
    rateLimitBucket: "mypage-read",
  });
  if (context instanceof Response) {
    return context;
  }

  const categoryId = params.id;
  if (!categoryId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "category id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      context.correlationId,
    );
  }

  const data = await getStorefrontCategoryAvailability(request, context.customerId, categoryId);
  return respond.ok(data, { correlationId: context.correlationId });
};
