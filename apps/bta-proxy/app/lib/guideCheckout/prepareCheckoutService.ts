import { createHash } from "crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { ErrorCode } from "~/lib/errors";
import { normalizeCustomerId } from "~/lib/coupons/normalize";
import { getState } from "~/lib/coupons/state";
import { isRevoked } from "~/lib/coupons/revoked";
import { resolveActiveExtra10 } from "~/lib/coupons/extra10Availability";
import { acquireLock, releaseLock } from "~/lib/coupons/lock";
import { getCouponRedisClient } from "~/lib/coupons/redisClient";
import { memoryGet, memorySet } from "~/lib/coupons/memoryStore";
import { getCouponRulesConfig } from "~/lib/coupons/config";
import { normalizeGuideVariantId, extractBaseTypeFromVariantId } from "~/lib/guideExtension/baseLineItems";
import { extractExtensionTypeFromVariantId } from "~/lib/guideExtension/extensionProduct";
import { createCart, applyCartDiscountCodes } from "~/lib/tourCheckout/storefrontCart";
import { createPrivateCheckoutDraft } from "~/lib/privateCheckout/draftOrder.server";
import type { GuidePrepareCheckoutInput } from "~/lib/validation";
import type {
  CheckoutMode,
  ThemeCartCheckoutIntent,
} from "~/lib/themeCartCheckout/types";
import {
  buildThemeCartAttributes,
  buildThemeCartItemsFromStorefrontLines,
  createThemeCartPrepareId,
} from "~/lib/themeCartCheckout/types";

export type GuideDecision =
  | "NONE"
  | "GUIDE50"
  | "EXTRA10"
  | "GUIDE50_EXTRA10";

type AppliedCodeMeta = {
  applied: boolean;
  discountType: "percent" | "fixed_amount";
  value: number;
};

export type GuideAppliedCodes = {
  guide50: AppliedCodeMeta;
  extra10: AppliedCodeMeta;
};

export type LegacyGuidePrepareCheckoutResult = {
  checkoutMode?: "private_draft";
  checkoutUrl: string;
  decision: GuideDecision;
  appliedCodes: GuideAppliedCodes;
  warnings: string[];
};

export type GuideThemeCartCheckoutResult = ThemeCartCheckoutIntent<
  GuideDecision,
  GuideAppliedCodes
>;

export type GuidePrepareCheckoutResult =
  | LegacyGuidePrepareCheckoutResult
  | GuideThemeCartCheckoutResult;

type IdempotencyEntry = {
  payloadHash: string;
  result: GuidePrepareCheckoutResult;
};

const IDEM_TTL_SECONDS = 6 * 60 * 60;

export class GuidePrepareCheckoutError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message);
    this.name = "GuidePrepareCheckoutError";
    this.code = code;
  }
}

function buildIdempotencyKey(customerId: string, clientRequestId: string): string {
  return `coupon:guide:prepare:${customerId}:${clientRequestId}`;
}

async function getIdempotencyEntry(
  customerId: string,
  clientRequestId: string
): Promise<IdempotencyEntry | null> {
  const key = buildIdempotencyKey(customerId, clientRequestId);
  const client = getCouponRedisClient();
  const raw = client ? await client.get(key) : memoryGet(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as IdempotencyEntry;
  } catch {
    return null;
  }
}

async function setIdempotencyEntry(
  customerId: string,
  clientRequestId: string,
  entry: IdempotencyEntry
): Promise<void> {
  const key = buildIdempotencyKey(customerId, clientRequestId);
  const raw = JSON.stringify(entry);
  const client = getCouponRedisClient();
  if (client) {
    await client.set(key, raw, "EX", IDEM_TTL_SECONDS);
    return;
  }
  memorySet(key, raw, IDEM_TTL_SECONDS);
}

function hashPayload(
  payload: GuidePrepareCheckoutInput,
  checkoutMode: CheckoutMode = "legacy_checkout_url",
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        checkoutMode,
        variantId: normalizeGuideVariantId(payload.variantId),
        quantity: payload.quantity,
        useExtra10: payload.useExtra10 === true,
      }),
      "utf8"
    )
    .digest("hex");
}

function createAppliedCodeMeta(
  appliedGuide50: boolean,
  appliedExtra10: boolean
): GuideAppliedCodes {
  return {
    guide50: {
      applied: appliedGuide50,
      discountType: "percent",
      value: 0.5,
    },
    extra10: {
      applied: appliedExtra10,
      discountType: "fixed_amount",
      value: 10,
    },
  };
}

function resolveDecision(appliedGuide50: boolean, appliedExtra10: boolean): GuideDecision {
  if (appliedGuide50 && appliedExtra10) return "GUIDE50_EXTRA10";
  if (appliedGuide50) return "GUIDE50";
  if (appliedExtra10) return "EXTRA10";
  return "NONE";
}

function isGuide50Available(params: {
  code: string | null;
  expiresAt: number | null;
  revoked: boolean;
  nowMs: number;
}) {
  const { code, expiresAt, revoked, nowMs } = params;
  if (!code || !expiresAt || revoked) {
    return false;
  }
  const expiresAtMs = expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000;
  return expiresAtMs > nowMs;
}

function isFeaturedGuideBundleVariant(variantId: string): boolean {
  const normalizedVariantId = normalizeGuideVariantId(variantId);
  if (!normalizedVariantId) return false;
  return getCouponRulesConfig().guideKitVariantIds.has(normalizedVariantId);
}

function buildCartLines(payload: GuidePrepareCheckoutInput) {
  const variantId = normalizeGuideVariantId(payload.variantId);
  if (!variantId) {
    throw new GuidePrepareCheckoutError(
      ErrorCode.VALIDATION_ERROR,
      "variantId가 올바르지 않습니다."
    );
  }

  return [
    {
      merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
      quantity: payload.quantity,
    },
  ];
}

async function resolveIdempotentResult(params: {
  admin?: AdminApiContext | null;
  customerId: string;
  payload: GuidePrepareCheckoutInput;
  checkoutMode?: CheckoutMode;
}): Promise<GuidePrepareCheckoutResult | null> {
  const { admin, customerId, payload } = params;
  if (!payload.clientRequestId) return null;

  const checkoutMode = params.checkoutMode || "legacy_checkout_url";
  const payloadHash = hashPayload(payload, checkoutMode);
  const entry = await getIdempotencyEntry(customerId, payload.clientRequestId);
  if (!entry) return null;

  if (entry.payloadHash !== payloadHash) {
    throw new GuidePrepareCheckoutError(
      ErrorCode.INTERNAL_CONFLICT,
      "동일한 clientRequestId에 다른 입력을 사용할 수 없습니다."
    );
  }

  if (entry.result.appliedCodes.extra10.applied) {
    const state = await getState(customerId);
    const extra10Availability = await resolveActiveExtra10({
      admin,
      customerId,
      state,
    });
    if (!extra10Availability.available) {
      console.warn(
        JSON.stringify({
          message: "Guide idempotent checkout bypassed",
          customerId,
          reason: extra10Availability.reason || null,
          shopifyReason: extra10Availability.shopifyReason || null,
        })
      );
      return null;
    }
  }

  return entry.result;
}

type PrepareGuideCheckoutParams = {
  admin?: AdminApiContext | null;
  shop: string;
  customerId: string;
  payload: GuidePrepareCheckoutInput;
  checkoutMode?: CheckoutMode;
};

export async function prepareGuideCheckout(
  params: PrepareGuideCheckoutParams & { checkoutMode: "theme_cart" },
): Promise<GuideThemeCartCheckoutResult>;
export async function prepareGuideCheckout(
  params: PrepareGuideCheckoutParams & { checkoutMode?: "legacy_checkout_url" },
): Promise<LegacyGuidePrepareCheckoutResult>;
export async function prepareGuideCheckout(
  params: PrepareGuideCheckoutParams,
): Promise<GuidePrepareCheckoutResult>;
export async function prepareGuideCheckout(
  params: PrepareGuideCheckoutParams,
): Promise<GuidePrepareCheckoutResult> {
  const { admin, shop, customerId, payload } = params;
  const checkoutMode = params.checkoutMode || "legacy_checkout_url";
  const normalizedCustomerId = normalizeCustomerId(customerId) || customerId;

  const existingResult = await resolveIdempotentResult({
    admin,
    customerId: normalizedCustomerId,
    payload,
    checkoutMode,
  });
  if (existingResult) {
    return existingResult;
  }

  const locked = await acquireLock("guidePrepareCheckout", normalizedCustomerId, 30);
  if (!locked) {
    throw new GuidePrepareCheckoutError(ErrorCode.INTERNAL_CONFLICT);
  }

  try {
    const retryResult = await resolveIdempotentResult({
      admin,
      customerId: normalizedCustomerId,
      payload,
      checkoutMode,
    });
    if (retryResult) {
      return retryResult;
    }

    const normalizedVariantId = normalizeGuideVariantId(payload.variantId);
    if (!normalizedVariantId) {
      throw new GuidePrepareCheckoutError(
        ErrorCode.VALIDATION_ERROR,
        "variantId가 올바르지 않습니다."
      );
    }

    if (extractExtensionTypeFromVariantId(normalizedVariantId)) {
      throw new GuidePrepareCheckoutError(
        ErrorCode.VALIDATION_ERROR,
        "extension 상품 variant는 guide prepare-checkout 대상이 아닙니다."
      );
    }

    const baseType = extractBaseTypeFromVariantId(normalizedVariantId);
    if (!baseType) {
      throw new GuidePrepareCheckoutError(
        ErrorCode.VALIDATION_ERROR,
        "variantId가 guide base 상품 variant가 아닙니다."
      );
    }

    const isFeaturedBundle = isFeaturedGuideBundleVariant(normalizedVariantId);
    const nowMs = Date.now();
    const state = await getState(normalizedCustomerId);
    const guide50Revoked = state.guide50Code
      ? await isRevoked(normalizedCustomerId, state.guide50Code)
      : false;
    const extra10Availability =
      payload.useExtra10 === true
        ? await resolveActiveExtra10({
            admin,
            customerId: normalizedCustomerId,
            state,
          })
        : null;

    const guide50Eligible =
      isFeaturedBundle &&
      isGuide50Available({
        code: state.guide50Code,
        expiresAt: state.guide50ExpiresAt,
        revoked: guide50Revoked,
        nowMs,
      });
    const extra10Eligible =
      payload.useExtra10 === true &&
      Boolean(extra10Availability?.available && extra10Availability.code);

    const warnings: string[] = [];
    if (payload.useExtra10 && !extra10Eligible) {
      warnings.push(
        extra10Availability?.reason === "SHOPIFY_INVALID"
          ? `EXTRA10_INVALID:${extra10Availability.shopifyReason || "unknown"}`
          : extra10Availability?.reason === "REVOKED"
            ? "EXTRA10_REVOKED"
            : "EXTRA10_NOT_AVAILABLE"
      );
    }
    if (isFeaturedBundle && !guide50Eligible && state.guide50Code) {
      if (guide50Revoked) {
        warnings.push("GUIDE50_REVOKED");
      } else if (state.guide50ExpiresAt) {
        warnings.push("GUIDE50_EXPIRED");
      }
    }

    const desiredCodes: string[] = [];
    if (guide50Eligible && state.guide50Code) {
      desiredCodes.push(state.guide50Code);
    }
    if (extra10Eligible && extra10Availability?.code) {
      desiredCodes.push(extra10Availability.code);
    }

    if (checkoutMode === "theme_cart") {
      const prepareId = createThemeCartPrepareId("GUIDE_BASE");
      const appliedGuide50 = Boolean(guide50Eligible && state.guide50Code);
      const appliedExtra10 = Boolean(
        extra10Eligible && extra10Availability?.code,
      );
      const result: GuideThemeCartCheckoutResult = {
        checkoutMode: "theme_cart",
        prepareId,
        clearCart: true,
        items: buildThemeCartItemsFromStorefrontLines({
          lines: buildCartLines(payload),
          prepareId,
          checkoutKind: "GUIDE_BASE",
        }),
        discountCodes: desiredCodes,
        expectedDiscountCodes: desiredCodes,
        cartAttributes: buildThemeCartAttributes({
          prepareId,
          checkoutKind: "GUIDE_BASE",
          decision: resolveDecision(appliedGuide50, appliedExtra10),
        }),
        redirectPath: "/checkout",
        decision: resolveDecision(appliedGuide50, appliedExtra10),
        appliedCodes: createAppliedCodeMeta(appliedGuide50, appliedExtra10),
        warnings,
      };

      if (payload.clientRequestId) {
        await setIdempotencyEntry(normalizedCustomerId, payload.clientRequestId, {
          payloadHash: hashPayload(payload, checkoutMode),
          result,
        });
      }

      console.log(
        JSON.stringify({
          message: "Guide theme cart checkout prepared",
          checkoutMode,
          prepareId,
          customerId: normalizedCustomerId,
          variantId: normalizedVariantId,
          baseType,
          isFeaturedBundle,
          decision: result.decision,
          itemsCount: result.items.length,
          discountCodesCount: result.discountCodes.length,
          warningsCount: warnings.length,
        })
      );

      return result;
    }

    const privateDraft = checkoutMode === "private_draft";
    if (privateDraft && !admin) throw new GuidePrepareCheckoutError(ErrorCode.SHOPIFY_ADMIN_API_ERROR);
    const cart = privateDraft
      ? await createPrivateCheckoutDraft(admin!, {
          customerId: normalizedCustomerId,
          lines: buildCartLines(payload),
          discountCodes: desiredCodes,
          kind: "GUIDE_BASE",
          decision: resolveDecision(guide50Eligible, extra10Eligible),
        })
      : await createCart(shop, buildCartLines(payload));
    let checkoutUrl = cart.checkoutUrl;
    let appliedCodes = cart.appliedCodes || [];

    if (!privateDraft && desiredCodes.length > 0 && "cartId" in cart) {
      const update = await applyCartDiscountCodes(shop, cart.cartId, desiredCodes);
      if (update.checkoutUrl) {
        checkoutUrl = update.checkoutUrl;
      }
      appliedCodes = update.appliedCodes;
      if (update.warnings.length > 0) {
        warnings.push(...update.warnings.map((warning) => `DISCOUNT_UPDATE:${warning}`));
      }
    }

    const appliedGuide50 = Boolean(
      guide50Eligible && state.guide50Code && appliedCodes.includes(state.guide50Code)
    );
    const appliedExtra10 = Boolean(
      extra10Eligible &&
        extra10Availability?.code &&
        appliedCodes.includes(extra10Availability.code)
    );

    if (guide50Eligible && state.guide50Code && !appliedGuide50) {
      warnings.push("GUIDE50_NOT_APPLIED");
    }
    if (extra10Eligible && extra10Availability?.code && !appliedExtra10) {
      warnings.push("EXTRA10_NOT_APPLIED");
    }

    const result: GuidePrepareCheckoutResult = {
      ...(privateDraft ? { checkoutMode: "private_draft" as const } : {}),
      checkoutUrl,
      decision: resolveDecision(appliedGuide50, appliedExtra10),
      appliedCodes: createAppliedCodeMeta(appliedGuide50, appliedExtra10),
      warnings,
    };

    if (payload.clientRequestId) {
      await setIdempotencyEntry(normalizedCustomerId, payload.clientRequestId, {
        payloadHash: hashPayload(payload, checkoutMode),
        result,
      });
    }

    console.log(
      JSON.stringify({
        message: "Guide checkout prepared",
        customerId: normalizedCustomerId,
        variantId: normalizedVariantId,
        baseType,
        isFeaturedBundle,
        decision: result.decision,
        warningsCount: warnings.length,
      })
    );

    return result;
  } finally {
    await releaseLock("guidePrepareCheckout", normalizedCustomerId);
  }
}
