import type { ActionFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { issueStorefrontAssetSignedUrl } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/domains/storefront/customerProxy.server.ts";

/**
 * POST /proxy/bta/mypage/assets/:id/signed-url
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "customer",
    rateLimitBucket: "signed-url",
  });
  if (context instanceof Response) {
    return context;
  }

  const assetId = params.id;
  if (!assetId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      context.correlationId,
    );
  }

  const result = await issueStorefrontAssetSignedUrl(request, context.customerId, assetId);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          "asset을 찾을 수 없거나 READY 상태가 아닙니다.",
        ),
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
