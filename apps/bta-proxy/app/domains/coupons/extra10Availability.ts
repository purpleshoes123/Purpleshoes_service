import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CouponState, DiscountStatusResult } from "./types";
import { clearExtra10Fields } from "./state";
import { markRevoked, isRevoked } from "./revoked";
import { fetchDiscountStatusByCode, fetchDiscountStatusById } from "./shopifyDiscounts";
import { maskCouponCode, maskCustomerId } from "./logging";

export type Extra10AvailabilityResult = {
  available: boolean;
  code: string | null;
  staleCleared: boolean;
  reason?: "NO_ACTIVE_EXTRA10" | "REVOKED" | "SHOPIFY_INVALID" | "SHOPIFY_UNKNOWN";
  shopifyReason?: string;
};

export async function resolveActiveExtra10(params: {
  admin?: AdminApiContext | null;
  customerId: string;
  state: CouponState;
}): Promise<Extra10AvailabilityResult> {
  const { admin, customerId, state } = params;
  if (!state.extra10Issued || !state.extra10Code) {
    return {
      available: false,
      code: null,
      staleCleared: false,
      reason: "NO_ACTIVE_EXTRA10",
    };
  }

  const revoked = await isRevoked(customerId, state.extra10Code);
  if (revoked) {
    await clearExtra10Fields(customerId);
    return {
      available: false,
      code: null,
      staleCleared: true,
      reason: "REVOKED",
    };
  }

  const status = await fetchExtra10Status({
    admin,
    customerId,
    code: state.extra10Code,
    discountId: state.extra10DiscountId,
  });

  if (status.status === "invalid") {
    await markRevoked(customerId, state.extra10Code);
    await clearExtra10Fields(customerId);
    console.warn(
      JSON.stringify({
        message: "Extra10 stale active state cleared",
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(state.extra10Code),
        reason: status.reason,
        usageLimit: status.usageLimit ?? null,
        usageCount: status.usageCount ?? null,
      }),
    );
    return {
      available: false,
      code: null,
      staleCleared: true,
      reason: "SHOPIFY_INVALID",
      shopifyReason: status.reason,
    };
  }

  if (status.status === "unknown") {
    return {
      available: true,
      code: state.extra10Code,
      staleCleared: false,
      reason: "SHOPIFY_UNKNOWN",
      shopifyReason: status.reason,
    };
  }

  return {
    available: true,
    code: state.extra10Code,
    staleCleared: false,
  };
}

async function fetchExtra10Status(params: {
  admin?: AdminApiContext | null;
  customerId: string;
  code: string;
  discountId: string | null;
}): Promise<DiscountStatusResult> {
  const { admin, customerId, code, discountId } = params;
  if (!admin) {
    console.warn(
      JSON.stringify({
        message: "Extra10 Shopify status lookup skipped",
        reason: "ADMIN_UNAVAILABLE",
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(code),
      }),
    );
    return { status: "unknown", reason: "admin_unavailable" };
  }

  if (discountId) {
    const byId = await fetchStatusSafely({
      lookup: "id",
      customerId,
      code,
      fn: () => fetchDiscountStatusById(admin, discountId),
    });
    if (byId.status !== "unknown" && (byId.status !== "invalid" || byId.reason !== "not_found")) {
      return byId;
    }

    const byCode = await fetchStatusSafely({
      lookup: byId.status === "unknown" ? "code_after_id_unknown" : "code_after_id_not_found",
      customerId,
      code,
      fn: () => fetchDiscountStatusByCode(admin, code),
    });
    if (byCode.status === "unknown") {
      return byCode;
    }
    return byCode;
  }

  return await fetchStatusSafely({
    lookup: "code",
    customerId,
    code,
    fn: () => fetchDiscountStatusByCode(admin, code),
  });
}

async function fetchStatusSafely(params: {
  lookup: "id" | "code" | "code_after_id_not_found" | "code_after_id_unknown";
  customerId: string;
  code: string;
  fn: () => Promise<DiscountStatusResult>;
}): Promise<DiscountStatusResult> {
  try {
    return await params.fn();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        message: "Extra10 Shopify status lookup failed",
        lookup: params.lookup,
        customerIdMasked: maskCustomerId(params.customerId),
        codeMasked: maskCouponCode(params.code),
        reason,
      }),
    );
    return { status: "unknown", reason };
  }
}
