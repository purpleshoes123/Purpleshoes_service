import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getTourCodeKind } from "~/domains/coupons/policy/codes";
import { revokeCode } from "~/domains/coupons/issuer";
import { clearTourPending } from "~/domains/checkout/tourCheckout/pending";
import { fetchOrderDiscountCodes } from "./orderQueries";
import { fetchOrderCustomerId } from "~/domains/checkout/guideExtension/orderCustomer";

export async function revokeTourCodesForOrder(params: {
  admin: AdminApiContext;
  orderId: string;
  customerId?: string | null;
  reason?: string;
}): Promise<{ revoked: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const { admin, orderId } = params;

  const codes = await fetchOrderDiscountCodes(admin, orderId);
  const tourCodes = codes.filter((code) => {
    const kind = getTourCodeKind(code);
    return kind === "TOUR5" || kind === "TOUR15" || kind === "TOUR20";
  });

  if (tourCodes.length === 0) {
    return { revoked: [], warnings };
  }

  let customerId = params.customerId || null;
  if (!customerId) {
    try {
      customerId = await fetchOrderCustomerId(admin, orderId);
    } catch (error) {
      warnings.push(
        `CUSTOMER_LOOKUP_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
      return { revoked: [], warnings };
    }
  }

  if (!customerId) {
    warnings.push("MISSING_CUSTOMER");
    return { revoked: [], warnings };
  }

  const revoked: string[] = [];
  for (const code of tourCodes) {
    try {
      await revokeCode(admin, customerId, code);
      revoked.push(code);
    } catch (error) {
      warnings.push(
        `REVOKE_FAILED:${code}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await clearTourPending(customerId);

  return { revoked, warnings };
}
