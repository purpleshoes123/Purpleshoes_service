import { enforceRateLimit } from "~/middleware/rateLimit";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { extractCustomerIdFromProxyRequest } from "~/lib/guideExtension/customerId";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  enforceStorefrontCustomerRateLimit,
  getStorefrontRateLimitMode,
  type StorefrontRateLimitBucket,
} from "~/lib/rateLimit/storefrontCustomerRateLimit.server";
import { respond } from "~/lib/respond";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";

export interface StorefrontCustomerProxyContext {
  correlationId: string;
  shop: string;
  customerId: string;
}

export type StorefrontCustomerRateLimitPolicy =
  | { rateLimitPolicy: "legacy" }
  | {
      rateLimitPolicy: "customer";
      rateLimitBucket: StorefrontRateLimitBucket;
    };

export async function requireStorefrontCustomerProxyContext(
  request: Request,
  policy: StorefrontCustomerRateLimitPolicy,
): Promise<StorefrontCustomerProxyContext | Response> {
  const useLegacyRateLimit =
    policy.rateLimitPolicy === "legacy" ||
    getStorefrontRateLimitMode() === "off";

  // `off` is an operational rollback switch, so its rate-limit/auth order is
  // intentionally identical to the pre-v2 implementation.
  if (useLegacyRateLimit) {
    const rateLimitResponse = await enforceRateLimit(request);
    if (rateLimitResponse) return rateLimitResponse;
  }

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  const correlationId = respond.getCorrelationId(request);
  const shop = extractShopFromRequest(request);
  if (!shop) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(
        ErrorCode.VALIDATION_ERROR,
        "shop 파라미터가 필요합니다.",
      ),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  const customerId = extractCustomerIdFromProxyRequest(request);
  if (!customerId) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId,
    );
  }

  if (policy.rateLimitPolicy === "customer" && !useLegacyRateLimit) {
    const rateLimitResponse = await enforceStorefrontCustomerRateLimit({
      shop,
      customerId,
      bucket: policy.rateLimitBucket,
      path: new URL(request.url).pathname,
      correlationId,
    });
    if (rateLimitResponse) return rateLimitResponse;
  }

  return {
    correlationId,
    shop,
    customerId,
  };
}
