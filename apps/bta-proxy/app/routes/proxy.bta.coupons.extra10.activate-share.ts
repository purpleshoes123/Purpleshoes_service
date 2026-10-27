import type { ActionFunctionArgs } from "react-router";
import { ZodError } from "zod";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { extractCustomerIdFromProxyRequest } from "~/lib/guideExtension/customerId";
import { extra10ActivateShareSchema } from "~/lib/coupons/validation";
import {
  activateExtra10Share,
  Extra10ShareActivationError,
} from "~/lib/coupons/shareActivation";

/**
 * POST /proxy/bta/coupons/extra10/activate-share
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

    const validated = extra10ActivateShareSchema.parse(body);

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

    const customerId = extractCustomerIdFromProxyRequest(request);
    if (!customerId) {
      return respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
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

    const result = await activateExtra10Share({
      admin,
      customerId,
      payload: validated,
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
        correlationId
      );
    }

    if (error instanceof Extra10ShareActivationError) {
      return respond.fail(
        error.code,
        getErrorMessage(error.code, error.message),
        undefined,
        getErrorStatus(error.code),
        correlationId
      );
    }

    console.error(
      JSON.stringify({
        message: "Extra10 activate-share failed",
        error: error instanceof Error ? error.message : String(error),
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
