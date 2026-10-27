import type { CheckoutMode } from "~/lib/themeCartCheckout/types";

type CheckoutArea = "tour" | "guide" | "extension";

const AREA_FLAGS: Record<CheckoutArea, string> = {
  tour: "BTA_THEME_CART_CHECKOUT_TOUR_ENABLED",
  guide: "BTA_THEME_CART_CHECKOUT_GUIDE_ENABLED",
  extension: "BTA_THEME_CART_CHECKOUT_EXTENSION_ENABLED",
};

function isEnabled(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function resolveCheckoutMode(request: Request, area: CheckoutArea, verifiedCustomerId?: string): CheckoutMode {
  // Server-only cutover. A browser query parameter must never activate this path.
  if (isEnabled(process.env.BTA_PRIVATE_CHECKOUT_ENABLED)) return "private_draft";
  const url = new URL(request.url);
  // Callers must authenticate the Shopify proxy before passing this identity.
  // The query flag alone cannot switch checkout for anonymous or other customers.
  const previewIds = (process.env.BTA_PRIVATE_CHECKOUT_PREVIEW_CUSTOMER_IDS || "").split(",").map(id => id.trim());
  const previewUntil = Date.parse(process.env.BTA_PRIVATE_CHECKOUT_PREVIEW_UNTIL || "");
  const previewCustomerId = verifiedCustomerId?.replace(/^gid:\/\/shopify\/Customer\//, "");
  if (url.searchParams.getAll("private_checkout_preview").length === 1
    && url.searchParams.get("private_checkout_preview") === "1"
    && previewCustomerId && /^[1-9]\d*$/.test(previewCustomerId)
    && previewIds.includes(previewCustomerId)
    && Number.isFinite(previewUntil) && previewUntil > Date.now()) {
    return "private_draft";
  }
  if (url.searchParams.has("private_checkout_preview")) throw new Error("PRIVATE_CHECKOUT_PREVIEW_UNAVAILABLE");
  if (url.searchParams.get("checkoutMode") === "private_draft") throw new Error("PRIVATE_CHECKOUT_UNAVAILABLE");
  const requested = url.searchParams.get("checkoutMode") === "theme_cart";
  if (!requested) return "legacy_checkout_url";

  const globallyEnabled = isEnabled(process.env.BTA_THEME_CART_CHECKOUT_ENABLED);
  const areaEnabled = isEnabled(process.env[AREA_FLAGS[area]]);
  return globallyEnabled && areaEnabled ? "theme_cart" : "legacy_checkout_url";
}

