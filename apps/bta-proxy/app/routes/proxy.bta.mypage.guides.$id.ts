import type { LoaderFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getStorefrontGuideDetail } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/domains/storefront/customerProxy.server.ts";

/**
 * GET /proxy/bta/mypage/guides/:id
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "legacy",
  });
  if (context instanceof Response) {
    return context;
  }

  const guideId = params.id;
  if (!guideId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      context.correlationId,
    );
  }

  const result = await getStorefrontGuideDetail(request, context.customerId, guideId);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide를 찾을 수 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        context.correlationId,
      );
    }

    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      context.correlationId,
    );
  }

  return respond.ok(result.data, { correlationId: context.correlationId });
};
