import type { ActionFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { extractCustomerIdFromProxyRequest } from "~/lib/guideExtension/customerId";
import { tourPrepareCheckoutSchema } from "~/lib/validation";
import { prepareTourCheckout } from "~/lib/tourCheckout/prepareCheckoutService";
import { resolveCheckoutMode } from "~/lib/checkoutMode.server";
import { resolveBookingProductId } from "~/lib/bookingContext.server";

/**
 * POST /proxy/bta/tour/prepare-checkout
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  const correlationId = respond.getCorrelationId(request);

  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
        );
      }
      throw error;
    }

    const validated = tourPrepareCheckoutSchema.parse(body);

    const shop = extractShopFromRequest(request);
    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const productId = await resolveBookingProductId(validated.productId, shop);
    if (!productId) {
      return respond.fail(ErrorCode.VALIDATION_ERROR, "예약 세션이 만료되었습니다. 페이지를 새로고침해 주세요.", undefined, 400, correlationId);
    }

    const customerId = extractCustomerIdFromProxyRequest(request);
    if (!customerId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "로그인이 필요합니다."),
        undefined,
        403,
        correlationId
      );
    }

    const admin = await getAdminApiClient(shop);
    if (!admin) {
      return respond.fail(
        ErrorCode.SHOPIFY_ADMIN_API_ERROR,
        getErrorMessage(
          ErrorCode.SHOPIFY_ADMIN_API_ERROR,
          "Shopify Admin API 세션을 찾을 수 없습니다."
        ),
        undefined,
        getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
        correlationId
      );
    }

    const checkoutMode = resolveCheckoutMode(request, "tour", customerId);
    const result = await prepareTourCheckout({
      admin,
      shop,
      customerId,
      checkoutMode,
      payload: {
        productId,
        date: validated.date,
        travelers: validated.travelers,
        variantId: validated.variantId,
        quantity: validated.quantity,
        bookingMode: validated.bookingMode,
        poolKey: validated.poolKey,
        guideUnitsRequired: validated.guideUnitsRequired,
        holdId: validated.holdId,
        properties: validated.properties,
        mediaConsent: validated.mediaConsent,
        useTour15: validated.useTour15,
        useExtra10: validated.useExtra10,
      },
    });

    if ("checkoutMode" in result && (result.checkoutMode === "theme_cart" || result.checkoutMode === "private_draft")) {
      return respond.ok(result, { correlationId });
    }

    return respond.ok(
      {
        checkoutUrl: result.checkoutUrl,
        decision: result.decision,
        appliedCodes: result.appliedCodes,
        creditBalance: result.creditBalance,
        warnings: result.warnings,
      },
      { correlationId }
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues
        .map((issue) => issue.message)
        .join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    if (message === "TOUR_CHECKOUT_LOCKED") {
      return respond.fail(
        ErrorCode.INTERNAL_CONFLICT,
        getErrorMessage(ErrorCode.INTERNAL_CONFLICT),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_CONFLICT),
        correlationId
      );
    }

    if (message === "TOUR_CODE_NOT_APPLIED") {
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        "투어 할인코드 적용에 실패했습니다. 잠시 후 다시 시도해주세요.",
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId
      );
    }

    console.error(
      JSON.stringify({
        message: "Tour prepare-checkout failed",
        error: message,
      })
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
