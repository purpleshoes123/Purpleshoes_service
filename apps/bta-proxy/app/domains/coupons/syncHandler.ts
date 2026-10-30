import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { couponsSyncSchema } from "./validation";
import {
  containsExtension,
  decideTourPercentCode,
  computeTargetCodes,
  validateCodes,
  getState,
  setMediaConsent,
  filterRevoked,
  resolveEffectiveMediaConsent,
} from "./index";
import { normalizeCustomerId } from "./normalize";
import { getCartDiscountAdapter } from "./sync";
import { applyCouponSync } from "./sync/sync";
import { handleInvalidCode } from "./invalid";
import type { CartDiscountAdapter } from "./sync";
import type { SyncResponse } from "./types";
import { extractCustomerIdFromProxyRequest } from "~/domains/checkout/guideExtension/customerId";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";

function resolveCustomerId(request: Request, bodyCustomerId?: string | null): string | null {
  const normalizedBody = normalizeCustomerId(bodyCustomerId || undefined);
  if (normalizedBody) {
    return normalizedBody;
  }
  const proxyId = extractCustomerIdFromProxyRequest(request);
  const normalizedProxy = normalizeCustomerId(proxyId || undefined);
  return normalizedProxy;
}

export async function handleCouponsSync(request: Request): Promise<Response> {
  const correlationId = respond.getCorrelationId(request);

  try {
    const body = await request.json();
    const validated = couponsSyncSchema.parse(body);

    const customerId = resolveCustomerId(request, validated.customerId);
    if (!customerId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const shop = extractShopFromRequest(request) || undefined;
    const adapter = getCartDiscountAdapter();

    if (!shop && adapter.constructor.name === "StorefrontCartDiscountAdapter") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const state = await getState(customerId);
    await setMediaConsent(customerId, validated.mediaConsent);

    const allowEntitledOverride =
      process.env.COUPON_ALLOW_ENTITLED_OVERRIDE === "true" ||
      process.env.NODE_ENV !== "production";
    const requestedEntitledTour15 =
      allowEntitledOverride && typeof validated.entitled15 === "boolean"
        ? validated.entitled15
        : state.entitledTour15;
    const entitledTour15 = state.tour15AdminBlocked ? false : requestedEntitledTour15;
    const effectiveMediaConsent = resolveEffectiveMediaConsent({
      payloadMediaConsent: validated.mediaConsent,
      state,
    });

    const extension = containsExtension(validated.cartLines);
    const tourPercentCode = decideTourPercentCode(
      Boolean(entitledTour15),
      Boolean(effectiveMediaConsent),
    );

    const allowExtra10WithoutCode =
      adapter.constructor.name === "MockCartDiscountAdapter" ||
      process.env.COUPON_ALLOW_EXTRA10_WITHOUT_CODE === "true";

    const targetCodes = computeTargetCodes({
      tourPercentCode,
      wantsExtra10: validated.wantsExtra10,
      containsExtension: extension,
      extra10Code: state.extra10Code,
      allowExtra10WithoutCode,
    });

    const warnings: string[] = [];
    if (validated.wantsExtra10 && !extension && !state.extra10Code && !allowExtra10WithoutCode) {
      warnings.push("EXTRA10_NOT_ISSUED");
    }

    const filteredTarget = await filterRevoked(customerId, targetCodes);
    if (filteredTarget.size !== targetCodes.size) {
      warnings.push("REVOKED_CODES_FILTERED");
    }

    validateCodes(filteredTarget);

    const applyResult = await applyCouponSync({
      cartId: validated.cartId,
      shop,
      adapter: adapter as CartDiscountAdapter,
      targetCodes: filteredTarget,
      containsExtension: extension,
      onInvalidCode: async (code) => {
        await handleInvalidCode(customerId, code);
      },
    });

    const response: SyncResponse = {
      appliedCodes: applyResult.appliedCodes,
      removedCodes: applyResult.removedCodes,
      addedCodes: applyResult.addedCodes,
      decision: {
        tourPercentCode,
        containsExtension: extension,
      },
      ...(applyResult.invalidCodes.length > 0 ? { invalidCodes: applyResult.invalidCodes } : {}),
      ...(warnings.length > 0 || applyResult.warnings.length > 0
        ? { warnings: [...warnings, ...applyResult.warnings] }
        : {}),
    };

    return respond.ok(response, { correlationId });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
}
