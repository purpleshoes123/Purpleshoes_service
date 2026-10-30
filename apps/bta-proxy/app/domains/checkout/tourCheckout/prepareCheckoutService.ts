import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { acquireLock, releaseLock } from "~/domains/coupons/lock";
import { normalizeCustomerId } from "~/domains/coupons/normalize";
import { getState, filterRevoked } from "~/domains/coupons";
import {
  resolveEffectiveMediaConsent,
  resolveEffectiveTour15Balance,
} from "~/domains/coupons/effectiveEligibility";
import { createTourPercentCode } from "~/domains/coupons/shopifyDiscounts";
import { prepareCartItems } from "~/domains/checkout/cartPrepareService";
import { fetchCustomerTourCreditBalance } from "~/domains/checkout/tourCredits/metafields";
import { applyCartDiscountCodes, createCart } from "./storefrontCart";
import { createPrivateCheckoutDraft } from "~/domains/checkout/privateCheckout/draftOrder.server.ts";
import { clearTourPending, getTourPending, setTourPending } from "./pending";
import { revokeCode } from "~/domains/coupons/issuer";
import { resolveActiveExtra10 } from "~/domains/coupons/extra10Availability";
import type {
  CheckoutMode,
  ThemeCartCheckoutIntent,
} from "~/domains/checkout/themeCartCheckout/types";
import {
  buildThemeCartAttributes,
  buildThemeCartItemsFromStorefrontLines,
  createThemeCartPrepareId,
} from "~/domains/checkout/themeCartCheckout/types";

export type TourDecision = "NONE" | "TOUR5" | "TOUR15" | "TOUR20";

export type PrepareCheckoutPayload = {
  productId: string;
  date: string;
  travelers?: { adult: number; child: number; infant: number };
  variantId?: string | null;
  quantity?: number | null;
  bookingMode?: "private" | "shared";
  poolKey?: string;
  guideUnitsRequired?: number;
  holdId?: string;
  properties?: Record<string, string | number | boolean>;
  mediaConsent: boolean;
  /** Omitted requests preserve the legacy behaviour of applying TOUR15. */
  useTour15?: boolean;
  useExtra10?: boolean;
};

export type TourAppliedCodes = { tourCode?: string; extra10Code?: string };

export type LegacyPrepareCheckoutResult = {
  checkoutMode?: "private_draft";
  checkoutUrl: string;
  decision: TourDecision;
  appliedCodes: TourAppliedCodes;
  creditBalance: number;
  warnings: string[];
};

export type TourThemeCartCheckoutResult = ThemeCartCheckoutIntent<
  TourDecision,
  TourAppliedCodes
> & {
  creditBalance: number;
};

export type PrepareCheckoutResult = LegacyPrepareCheckoutResult | TourThemeCartCheckoutResult;

const DEFAULT_PENDING_TTL = 6 * 60 * 60;

function resolveDecision(balance: number, mediaConsent: boolean): TourDecision {
  if (balance >= 1 && mediaConsent) {
    return "TOUR20";
  }
  if (balance >= 1 && !mediaConsent) {
    return "TOUR15";
  }
  if (balance === 0 && mediaConsent) {
    return "TOUR5";
  }
  return "NONE";
}

function normalizeVariantGid(variantId: string): string {
  if (variantId.startsWith("gid://")) {
    return variantId;
  }
  return `gid://shopify/ProductVariant/${variantId}`;
}

function buildTourCode(kind: Exclude<TourDecision, "NONE">, customerId: string): string {
  const normalized = normalizeCustomerId(customerId) || customerId.replace(/\D/g, "");
  const stamp = Date.now();
  return `${kind}-${normalized}-${stamp}`;
}

async function buildCartLines(params: {
  shop: string;
  payload: PrepareCheckoutPayload;
  effectiveMediaConsent: boolean;
}): Promise<{
  lines: Array<{
    merchandiseId: string;
    quantity: number;
    attributes: Array<{ key: string; value: string }>;
  }>;
  variantIds: string[];
}> {
  const { shop, payload, effectiveMediaConsent } = params;
  if (payload.variantId && payload.quantity) {
    const merchandiseId = normalizeVariantGid(payload.variantId);
    const baseProps = payload.properties || {};
    const attributes = Object.entries(baseProps).map(([key, value]) => ({
      key,
      value:
        key === "media_consent"
          ? String(effectiveMediaConsent)
          : value === null || value === undefined
            ? ""
            : String(value),
    }));
    if (!("media_consent" in baseProps)) {
      attributes.push({
        key: "media_consent",
        value: String(effectiveMediaConsent),
      });
    }
    if (!("travel_date" in baseProps) && !("travelDate" in baseProps)) {
      attributes.push({ key: "travel_date", value: payload.date });
    }
    return {
      lines: [
        {
          merchandiseId,
          quantity: payload.quantity,
          attributes,
        },
      ],
      variantIds: [merchandiseId],
    };
  }

  if (!payload.travelers) {
    throw new Error("travelers or variantId/quantity is required");
  }

  const prepared = await prepareCartItems(
    payload.productId,
    payload.date,
    payload.travelers,
    shop,
    {
      bookingMode: payload.bookingMode,
      poolKey: payload.poolKey,
      guideUnitsRequired: payload.guideUnitsRequired,
      holdId: payload.holdId,
    },
  );

  const baseAttributes = Object.entries(prepared.properties).map(([key, value]) => ({
    key,
    value: key === "media_consent" ? String(effectiveMediaConsent) : value,
  }));
  const baseKeys = new Set(baseAttributes.map((attr) => attr.key));
  const mergedProperties: Record<string, string | number | boolean> = {
    ...(payload.properties || {}),
    media_consent: String(effectiveMediaConsent),
  };
  const extraAttributes = Object.entries(mergedProperties)
    .filter(([key]) => !baseKeys.has(key))
    .map(([key, value]) => ({
      key,
      value: value === null || value === undefined ? "" : String(value),
    }));

  const attributes = [...baseAttributes, ...extraAttributes];
  const lines = prepared.items.map((item) => ({
    merchandiseId: normalizeVariantGid(item.variantId),
    quantity: item.quantity,
    attributes,
  }));

  return {
    lines,
    variantIds: Array.from(new Set(lines.map((line) => line.merchandiseId))),
  };
}

async function revokePendingIfExists(
  admin: AdminApiContext,
  customerId: string,
  warnings: string[],
): Promise<void> {
  const pending = await getTourPending(customerId);
  if (!pending) {
    return;
  }

  try {
    await revokeCode(admin, customerId, pending.code, pending.discountId || undefined);
  } catch (error) {
    warnings.push(
      `PENDING_REVOKE_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await clearTourPending(customerId);
  }
}

type PrepareTourCheckoutParams = {
  admin: AdminApiContext;
  shop: string;
  customerId: string;
  payload: PrepareCheckoutPayload;
  checkoutMode?: CheckoutMode;
};

export async function prepareTourCheckout(
  params: PrepareTourCheckoutParams & { checkoutMode: "theme_cart" },
): Promise<TourThemeCartCheckoutResult>;
export async function prepareTourCheckout(
  params: PrepareTourCheckoutParams & { checkoutMode?: "legacy_checkout_url" },
): Promise<LegacyPrepareCheckoutResult>;
export async function prepareTourCheckout(
  params: PrepareTourCheckoutParams,
): Promise<PrepareCheckoutResult>;
export async function prepareTourCheckout(
  params: PrepareTourCheckoutParams,
): Promise<PrepareCheckoutResult> {
  const { admin, shop, customerId, payload } = params;
  const checkoutMode = params.checkoutMode || "legacy_checkout_url";
  const warnings: string[] = [];

  if (checkoutMode === "private_draft" && (!payload.travelers || payload.variantId)) {
    // Private mode always derives the variants from the validated product/pax tier.
    throw new Error("PRIVATE_CHECKOUT_TRAVELERS_REQUIRED");
  }

  const lockCustomerId = normalizeCustomerId(customerId) || customerId;
  const locked = await acquireLock("tourPrepareCheckout", lockCustomerId, 30);
  if (!locked) {
    throw new Error("TOUR_CHECKOUT_LOCKED");
  }

  try {
    await revokePendingIfExists(admin, customerId, warnings);

    const balance = await fetchCustomerTourCreditBalance(admin, customerId);
    const state = await getState(customerId);
    const effectiveBalance = resolveEffectiveTour15Balance({
      rawCreditBalance: balance,
      state,
    });
    const effectiveMediaConsent = resolveEffectiveMediaConsent({
      payloadMediaConsent: payload.mediaConsent,
      state,
    });
    const appliedTour15Balance = payload.useTour15 === false ? 0 : effectiveBalance;
    const decision = resolveDecision(appliedTour15Balance, effectiveMediaConsent);

    const { lines, variantIds } = await buildCartLines({
      shop,
      payload,
      effectiveMediaConsent,
    });

    let tourCode: string | undefined;
    let tourDiscountId: string | null = null;

    if (decision !== "NONE") {
      tourCode = buildTourCode(decision, customerId);
      const discount = await createTourPercentCode(admin, {
        code: tourCode,
        kind: decision,
        variantIds,
        endsAtHours: 6,
      });
      tourDiscountId = discount.discountId;
    }

    const extra10Wanted = payload.useExtra10 === true;
    let extra10Code: string | null = null;
    if (extra10Wanted) {
      const extra10Availability = await resolveActiveExtra10({
        admin,
        customerId,
        state,
      });
      extra10Code = extra10Availability.available ? extra10Availability.code : null;
      if (!extra10Code) {
        warnings.push(
          extra10Availability.reason === "SHOPIFY_INVALID"
            ? `EXTRA10_INVALID:${extra10Availability.shopifyReason || "unknown"}`
            : extra10Availability.reason === "REVOKED"
              ? "EXTRA10_REVOKED"
              : "EXTRA10_NOT_ISSUED",
        );
      }
    }
    const codes = new Set<string>();
    if (tourCode) {
      codes.add(tourCode);
    }
    if (extra10Code) {
      codes.add(extra10Code);
    }
    const filteredCodes = await filterRevoked(customerId, codes);
    if (extra10Code && !filteredCodes.has(extra10Code)) {
      warnings.push("EXTRA10_REVOKED");
      extra10Code = null;
    }

    const finalCodes = Array.from(filteredCodes);
    const appliedCodePayload: TourAppliedCodes = {
      ...(tourCode ? { tourCode } : {}),
      ...(extra10Code && finalCodes.includes(extra10Code) ? { extra10Code } : {}),
    };

    if (checkoutMode === "theme_cart") {
      const prepareId = createThemeCartPrepareId("TOUR");
      if (tourCode) {
        await setTourPending(
          customerId,
          {
            code: tourCode,
            kind: decision as Exclude<TourDecision, "NONE">,
            issuedAt: new Date().toISOString(),
            discountId: tourDiscountId,
            cartId: null,
            checkoutUrl: null,
            prepareId,
          },
          DEFAULT_PENDING_TTL,
        );
      }

      console.log(
        JSON.stringify({
          message: "Tour theme cart checkout prepared",
          checkoutMode,
          prepareId,
          customerId: lockCustomerId,
          decision,
          itemsCount: lines.length,
          discountCodesCount: finalCodes.length,
          warningsCount: warnings.length,
          creditBalance: effectiveBalance,
          rawCreditBalance: balance,
          entitledTour15: state.entitledTour15,
          tour15AdminBlocked: state.tour15AdminBlocked,
          mediaConsent: payload.mediaConsent,
          effectiveMediaConsent,
          mediaConsentAdminOverride: state.mediaConsentAdminOverride,
        }),
      );

      return {
        checkoutMode: "theme_cart",
        prepareId,
        clearCart: true,
        items: buildThemeCartItemsFromStorefrontLines({
          lines,
          prepareId,
          checkoutKind: "TOUR",
        }),
        discountCodes: finalCodes,
        expectedDiscountCodes: finalCodes,
        cartAttributes: buildThemeCartAttributes({
          prepareId,
          checkoutKind: "TOUR",
          decision,
        }),
        redirectPath: "/checkout",
        decision,
        appliedCodes: appliedCodePayload,
        creditBalance: effectiveBalance,
        warnings,
      };
    }

    let cart;
    try {
      cart =
        checkoutMode === "private_draft"
          ? await createPrivateCheckoutDraft(admin, {
              customerId,
              lines,
              discountCodes: finalCodes,
              kind: "TOUR",
              decision,
            })
          : await createCart(shop, lines);
    } catch (error) {
      if (tourCode) {
        try {
          await revokeCode(admin, customerId, tourCode, tourDiscountId || undefined);
        } catch (revokeError) {
          warnings.push(
            `TOUR_CODE_ROLLBACK_FAILED:${
              revokeError instanceof Error ? revokeError.message : String(revokeError)
            }`,
          );
        }
      }
      throw error;
    }

    let checkoutUrl = cart.checkoutUrl;
    let appliedCodes = cart.appliedCodes || [];
    if (checkoutMode !== "private_draft" && finalCodes.length > 0 && "cartId" in cart) {
      const update = await applyCartDiscountCodes(shop, cart.cartId, finalCodes);
      checkoutUrl = update.checkoutUrl || checkoutUrl;
      appliedCodes = update.appliedCodes;
      if (update.warnings.length > 0) {
        warnings.push(...update.warnings.map((w) => `DISCOUNT_UPDATE:${w}`));
      }
    }

    if (tourCode && !appliedCodes.includes(tourCode)) {
      try {
        await revokeCode(admin, customerId, tourCode, tourDiscountId || undefined);
      } catch (error) {
        warnings.push(
          `TOUR_CODE_REVOKE_FAILED:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new Error("TOUR_CODE_NOT_APPLIED");
    }

    if (tourCode) {
      await setTourPending(
        customerId,
        {
          code: tourCode,
          kind: decision as Exclude<TourDecision, "NONE">,
          issuedAt: new Date().toISOString(),
          discountId: tourDiscountId,
          cartId: "cartId" in cart ? cart.cartId : null,
          checkoutUrl,
        },
        DEFAULT_PENDING_TTL,
      );
    }

    const extra10Applied = extra10Code && appliedCodes.includes(extra10Code) ? extra10Code : null;
    if (extra10Code && !extra10Applied) {
      warnings.push("EXTRA10_NOT_APPLIED");
      extra10Code = null;
    }

    console.log(
      JSON.stringify({
        message: "Tour checkout prepared",
        customerId: lockCustomerId,
        decision,
        tourCode: tourCode || null,
        extra10Code: extra10Code || null,
        warningsCount: warnings.length,
        creditBalance: effectiveBalance,
        rawCreditBalance: balance,
        entitledTour15: state.entitledTour15,
        tour15AdminBlocked: state.tour15AdminBlocked,
        mediaConsent: payload.mediaConsent,
        effectiveMediaConsent,
        mediaConsentAdminOverride: state.mediaConsentAdminOverride,
      }),
    );

    return {
      ...(checkoutMode === "private_draft" ? { checkoutMode: "private_draft" as const } : {}),
      checkoutUrl,
      decision,
      appliedCodes: {
        ...(tourCode ? { tourCode } : {}),
        ...(extra10Applied ? { extra10Code: extra10Applied } : {}),
      },
      creditBalance: effectiveBalance,
      warnings,
    };
  } finally {
    await releaseLock("tourPrepareCheckout", lockCustomerId);
  }
}
