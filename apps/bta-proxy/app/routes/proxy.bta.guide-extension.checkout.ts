import type { ActionFunctionArgs } from "react-router";
import { verifyMemberAppProxy as verifyAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { memberRespond as respond } from "~/middleware/verifyMemberAppProxy";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import {
  addFixedMonthDaysKstEndOfDay,
  extractCustomerIdFromProxyRequest,
  getCustomerEntitlements,
  isActive,
  normalizeToKstEndOfDay,
} from "~/lib/guideExtension";
import { guideExtensionCheckoutSchema } from "~/lib/validation";
import { createGuideExtensionDraftOrder } from "~/lib/guideExtension/draftOrder";
import { resolveCheckoutMode } from "~/lib/checkoutMode.server";
import { createPrivateCheckoutDraft } from "~/lib/privateCheckout/draftOrder.server";
import {
  buildThemeCartAttributes,
  createThemeCartPrepareId,
  normalizeAjaxVariantId,
} from "~/lib/themeCartCheckout/types";

function resolveVariantId(type: "PDF" | "VIDEO" | "BUNDLE"): string | null {
  const envKey = `GUIDE_EXT_VARIANT_ID_${type}`;
  const raw = process.env[envKey];
  if (!raw || !raw.trim()) {
    return null;
  }
  return raw.trim();
}

/**
 * SSOT: POST /proxy/bta/guide-extension/checkout
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
          ErrorCode.GUIDE_EXTENSION_INVALID_INPUT,
          getErrorMessage(
            ErrorCode.GUIDE_EXTENSION_INVALID_INPUT,
            "잘못된 JSON 형식입니다."
          ),
          undefined,
          getErrorStatus(ErrorCode.GUIDE_EXTENSION_INVALID_INPUT),
          correlationId
        );
      }
      throw error;
    }

    const validatedInput = guideExtensionCheckoutSchema.parse(body);

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
        ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE,
        "로그인 상태를 확인할 수 없습니다. 다시 로그인 후 시도해주세요.",
        undefined,
        getErrorStatus(ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE),
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

    const entitlements = await getCustomerEntitlements(admin, customerId);
    const currentExpiresAt = entitlements[validatedInput.type] ?? null;

    if (!currentExpiresAt) {
      return respond.fail(
        ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE,
        getErrorMessage(ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE),
        undefined,
        getErrorStatus(ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE),
        correlationId
      );
    }

    let normalizedCurrent: string;
    try {
      normalizedCurrent = normalizeToKstEndOfDay(currentExpiresAt);
    } catch {
      return respond.fail(
        ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE,
        getErrorMessage(ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE),
        undefined,
        getErrorStatus(ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE),
        correlationId
      );
    }

    if (!isActive(normalizedCurrent, new Date())) {
      return respond.fail(
        ErrorCode.GUIDE_EXTENSION_EXPIRED,
        getErrorMessage(ErrorCode.GUIDE_EXTENSION_EXPIRED),
        undefined,
        getErrorStatus(ErrorCode.GUIDE_EXTENSION_EXPIRED),
        correlationId
      );
    }

    const newExpiresAt = addFixedMonthDaysKstEndOfDay(
      normalizedCurrent,
      validatedInput.months
    );

    const variantId = resolveVariantId(validatedInput.type);
    if (!variantId) {
      return respond.fail(
        ErrorCode.GUIDE_EXTENSION_CONFIG_ERROR,
        getErrorMessage(
          ErrorCode.GUIDE_EXTENSION_CONFIG_ERROR,
          `GUIDE_EXT_VARIANT_ID_${validatedInput.type} 설정이 필요합니다.`
        ),
        undefined,
        getErrorStatus(ErrorCode.GUIDE_EXTENSION_CONFIG_ERROR),
        correlationId
      );
    }

    const tags = [
      "GUIDE_EXT",
      `GUIDE_EXT_${validatedInput.type}`,
      `GUIDE_EXT_M${validatedInput.months}`,
    ];
    const note = `Guide extension purchase: type=${validatedInput.type}, months=${validatedInput.months}`;

    const checkoutMode = resolveCheckoutMode(request, "extension", customerId);
    if (checkoutMode === "theme_cart") {
      const prepareId = createThemeCartPrepareId("GUIDE_EXTENSION");

      return respond.ok(
        {
          checkoutMode: "theme_cart",
          prepareId,
          clearCart: true,
          items: [
            {
              id: normalizeAjaxVariantId(variantId),
              quantity: validatedInput.months,
              properties: {
                _bta_prepare_id: prepareId,
                _bta_checkout_kind: "GUIDE_EXTENSION",
                guide_extension_type: validatedInput.type,
                guide_extension_months: String(validatedInput.months),
                current_expires_at_kst: normalizedCurrent,
                new_expires_at_kst: newExpiresAt,
              },
            },
          ],
          discountCodes: [],
          expectedDiscountCodes: [],
          cartAttributes: buildThemeCartAttributes({
            prepareId,
            checkoutKind: "GUIDE_EXTENSION",
            decision: "GUIDE_EXTENSION",
          }),
          redirectPath: "/checkout",
          decision: "GUIDE_EXTENSION",
          appliedCodes: {},
          warnings: [],
          preview: {
            currentExpiresAtKst: normalizedCurrent,
            newExpiresAtKst: newExpiresAt,
          },
        },
        { correlationId }
      );
    }

    const draftOrder = checkoutMode === "private_draft"
      ? await createPrivateCheckoutDraft(admin, {
          customerId,
          lines: [{
            merchandiseId: `gid://shopify/ProductVariant/${normalizeAjaxVariantId(variantId)}`,
            quantity: validatedInput.months,
            attributes: [
              { key: "guide_extension_type", value: validatedInput.type },
              { key: "guide_extension_months", value: String(validatedInput.months) },
              { key: "current_expires_at_kst", value: normalizedCurrent },
              { key: "new_expires_at_kst", value: newExpiresAt },
            ],
          }],
          discountCodes: [], kind: "GUIDE_EXTENSION", decision: "GUIDE_EXTENSION", tags, note,
        })
      : await createGuideExtensionDraftOrder(admin, {
      customerId,
      variantId,
      quantityMonths: validatedInput.months,
      tags,
      note,
    });

    return respond.ok(
      {
        draftOrderId: draftOrder.draftOrderId,
        checkoutUrl: draftOrder.checkoutUrl,
        preview: {
          currentExpiresAtKst: normalizedCurrent,
          newExpiresAtKst: newExpiresAt,
        },
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
        ErrorCode.GUIDE_EXTENSION_INVALID_INPUT,
        getErrorMessage(ErrorCode.GUIDE_EXTENSION_INVALID_INPUT, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.GUIDE_EXTENSION_INVALID_INPUT),
        correlationId
      );
    }

    console.error(
      JSON.stringify({
        message: "Guide extension checkout error",
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return respond.fail(
      ErrorCode.SHOPIFY_ADMIN_API_ERROR,
      getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      undefined,
      getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      correlationId
    );
  }
};
