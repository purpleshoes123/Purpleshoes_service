import type { LoaderFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import {
  evaluateGuideBasePurchaseEligibility,
  extractBaseTypeFromVariantId,
  extractCustomerIdFromProxyRequest,
  getCustomerEntitlements,
} from "~/domains/checkout/guideExtension";
import { guideBasePurchaseEligibilityQuerySchema } from "~/lib/validation";

/**
 * GET /proxy/bta/guide-purchase/eligibility
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) {
    return verifyResponse;
  }

  const correlationId = respond.getCorrelationId(request);

  try {
    const shop = extractShopFromRequest(request);
    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
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

    const url = new URL(request.url);
    const query = guideBasePurchaseEligibilityQuerySchema.parse({
      variantId: url.searchParams.get("variantId") || "",
    });

    const requestedType = extractBaseTypeFromVariantId(query.variantId);
    if (!requestedType) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "variantId가 GUIDE base 상품이 아닙니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const admin = await getAdminApiClient(shop);
    if (!admin) {
      return respond.fail(
        ErrorCode.SHOPIFY_ADMIN_API_ERROR,
        getErrorMessage(
          ErrorCode.SHOPIFY_ADMIN_API_ERROR,
          "Shopify Admin API 세션을 찾을 수 없습니다.",
        ),
        undefined,
        getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
        correlationId,
      );
    }

    const entitlements = await getCustomerEntitlements(admin, customerId);
    const result = evaluateGuideBasePurchaseEligibility({
      requestedVariantId: query.variantId,
      requestedType,
      entitlements,
    });

    return respond.ok(result, { correlationId });
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => issue.message).join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, message),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    console.error(
      JSON.stringify({
        message: "Guide base purchase eligibility error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
