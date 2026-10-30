import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { extractCustomerIdFromProxyRequest } from "~/domains/checkout/guideExtension/customerId";
import { guidePrepareCheckoutSchema } from "~/lib/validation";
import {
  GuidePrepareCheckoutError,
  prepareGuideCheckout,
} from "~/domains/checkout/guideCheckout/prepareCheckoutService";
import { resolveCheckoutMode } from "~/domains/checkout/checkoutMode.server.ts";

/**
 * POST /proxy/bta/guide/prepare-checkout
 */
export const action = async ({ request }: ActionFunctionArgs) => {
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
          correlationId,
        );
      }
      throw error;
    }

    const validated = guidePrepareCheckoutSchema.parse(body);

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

    let admin: Awaited<ReturnType<typeof getAdminApiClient>> | null = null;
    try {
      admin = await getAdminApiClient(shop);
    } catch (adminError) {
      console.warn(
        JSON.stringify({
          message: "Guide prepare-checkout admin lookup failed",
          shop,
          correlationId,
          error: adminError instanceof Error ? adminError.message : String(adminError),
        }),
      );
    }
    if (!admin) {
      console.warn(
        JSON.stringify({
          message: "Guide prepare-checkout admin unavailable",
          shop,
          correlationId,
        }),
      );
    }

    const checkoutMode = resolveCheckoutMode(request, "guide", customerId);
    const result = await prepareGuideCheckout({
      admin,
      shop,
      customerId,
      checkoutMode,
      payload: validated,
    });

    if (
      "checkoutMode" in result &&
      (result.checkoutMode === "theme_cart" || result.checkoutMode === "private_draft")
    ) {
      return respond.ok(result, { correlationId });
    }

    return respond.ok(
      {
        checkoutUrl: result.checkoutUrl,
        decision: result.decision,
        appliedCodes: result.appliedCodes,
        warnings: result.warnings,
      },
      { correlationId },
    );
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

    if (error instanceof GuidePrepareCheckoutError) {
      const message =
        error.code === ErrorCode.VALIDATION_ERROR && error.message
          ? error.message
          : getErrorMessage(error.code, error.message);
      return respond.fail(
        error.code,
        message,
        undefined,
        getErrorStatus(error.code),
        correlationId,
      );
    }

    console.error(
      JSON.stringify({
        message: "Guide prepare-checkout failed",
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
