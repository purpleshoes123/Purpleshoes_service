import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { fetchOrderCustomerId } from "~/lib/guideExtension/orderCustomer";
import { fetchOrderDiscountCodes } from "~/lib/tourCredits/orderQueries";
import { extractExtra10DiscountCodes } from "./orderUtils";
import { tryMarkEventOnce } from "./idempotency";
import { issueExtra10 } from "./issuer";
import { getState } from "./state";
import { resolveActiveExtra10 } from "./extra10Availability";
import { normalizeCustomerId } from "./normalize";
import { maskCouponCode, maskCustomerId } from "./logging";

export type RestoreExtra10Result = {
  restored: boolean;
  reason?:
    | "NO_EXTRA10_CODE"
    | "ALREADY_RESTORED"
    | "MISSING_CUSTOMER"
    | "ALREADY_HAS_ACTIVE_EXTRA10"
    | "ISSUE_FAILED";
  oldCode?: string | null;
  newCode?: string | null;
  warnings: string[];
};

export async function restoreExtra10ForOrder(params: {
  admin: AdminApiContext;
  orderId: string;
  customerId?: string | null;
  refundId?: string | null;
  reason: string;
}): Promise<RestoreExtra10Result> {
  const { admin, orderId, refundId } = params;
  const warnings: string[] = [];
  const codes = await fetchOrderDiscountCodes(admin, orderId);
  const extra10Codes = extractExtra10DiscountCodes({ discount_codes: codes });
  const oldCode = extra10Codes[0] || null;

  console.log(
    JSON.stringify({
      message: "Extra10 restore check",
      orderId,
      refundId: refundId || null,
      reason: params.reason,
      extra10CodesCount: extra10Codes.length,
      extra10CodesMasked: extra10Codes.map(maskCouponCode),
    })
  );

  if (!oldCode) {
    return { restored: false, reason: "NO_EXTRA10_CODE", oldCode: null, warnings };
  }

  const marked = await tryMarkEventOnce(
    "extra10_restore",
    orderId,
    180 * 24 * 60 * 60
  );
  if (!marked) {
    return { restored: false, reason: "ALREADY_RESTORED", oldCode, warnings };
  }

  let customerId = params.customerId || null;
  if (!customerId) {
    try {
      customerId = await fetchOrderCustomerId(admin, orderId);
    } catch (error) {
      warnings.push(
        `CUSTOMER_LOOKUP_FAILED:${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!customerId) {
    return { restored: false, reason: "MISSING_CUSTOMER", oldCode, warnings };
  }

  const normalizedCustomerKey = normalizeCustomerId(customerId) || customerId;
  const state = await getState(normalizedCustomerKey);
  const activeExtra10 = await resolveActiveExtra10({
    admin,
    customerId: normalizedCustomerKey,
    state,
  });
  if (activeExtra10.available && activeExtra10.code) {
    console.log(
      JSON.stringify({
        message: "Extra10 restore skipped",
        reason: "ALREADY_HAS_ACTIVE_EXTRA10",
        orderId,
        refundId: refundId || null,
        customerIdMasked: maskCustomerId(normalizedCustomerKey),
        oldCodeMasked: maskCouponCode(oldCode),
        activeCodeMasked: maskCouponCode(activeExtra10.code),
      })
    );
    return {
      restored: false,
      reason: "ALREADY_HAS_ACTIVE_EXTRA10",
      oldCode,
      newCode: activeExtra10.code,
      warnings,
    };
  }

  console.log(
    JSON.stringify({
      message: "Extra10 restore issuing replacement",
      orderId,
      refundId: refundId || null,
      customerIdMasked: maskCustomerId(normalizedCustomerKey),
      oldCodeMasked: maskCouponCode(oldCode),
    })
  );

  const issueResult = await issueExtra10(admin, normalizedCustomerKey, { force: true });
  if (!issueResult.code) {
    warnings.push(issueResult.reason ? `ISSUE_FAILED:${issueResult.reason}` : "ISSUE_FAILED");
    return { restored: false, reason: "ISSUE_FAILED", oldCode, warnings };
  }

  console.log(
    JSON.stringify({
      message: "Extra10 restore completed",
      orderId,
      refundId: refundId || null,
      customerIdMasked: maskCustomerId(normalizedCustomerKey),
      oldCodeMasked: maskCouponCode(oldCode),
      newCodeMasked: maskCouponCode(issueResult.code),
    })
  );

  return {
    restored: true,
    oldCode,
    newCode: issueResult.code,
    warnings,
  };
}
