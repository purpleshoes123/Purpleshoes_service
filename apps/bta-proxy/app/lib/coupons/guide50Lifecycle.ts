import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getState, setGuide50ConsumedFields, clearGuide50Fields, clearGuide50ConsumedFields } from "./state";
import { issueGuide50 } from "./issuer";
import { markRevoked } from "./revoked";
import { normalizeCode, normalizeCustomerId } from "./normalize";
import { maskCouponCode, maskCustomerId } from "./logging";

export type Guide50ConsumeResult = {
  consumed: boolean;
  stateCleared: boolean;
  reason?: "CUSTOMER_ID_INVALID" | "NO_ACTIVE_GUIDE50" | "CODE_MISMATCH";
};

export type Guide50RestoreResult = {
  restored: boolean;
  reason?:
    | "CUSTOMER_ID_INVALID"
    | "NO_CONSUMED_GUIDE50"
    | "ORDER_MISMATCH"
    | "EXPIRED"
    | "ISSUE_FAILED";
  code?: string | null;
  expiresAt?: number | null;
};

export async function consumeGuide50ForOrder(params: {
  customerId: string;
  orderId: string;
  code: string;
  consumedAt?: number;
}): Promise<Guide50ConsumeResult> {
  const customerId = normalizeCustomerId(params.customerId);
  if (!customerId) {
    console.warn(
      JSON.stringify({
        message: "Guide50 consume skipped",
        reason: "CUSTOMER_ID_INVALID",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(params.customerId),
        codeMasked: maskCouponCode(params.code),
      })
    );
    return { consumed: false, stateCleared: false, reason: "CUSTOMER_ID_INVALID" };
  }

  const state = await getState(customerId);
  const normalizedCode = normalizeCode(params.code);
  const currentCode = normalizeCode(state.guide50Code);

  console.log(
    JSON.stringify({
      message: "Guide50 consume check",
      orderId: params.orderId,
      customerIdMasked: maskCustomerId(customerId),
      codeMasked: maskCouponCode(normalizedCode),
      hasActiveGuide50: Boolean(state.guide50Code),
      hasIssuedAt: Boolean(state.guide50IssuedAt),
      hasExpiresAt: Boolean(state.guide50ExpiresAt),
      activeCodeMasked: maskCouponCode(state.guide50Code),
      activeExpiresAt: state.guide50ExpiresAt,
      existingConsumedOrderId: state.guide50ConsumedOrderId,
      existingConsumedCodeMasked: maskCouponCode(state.guide50ConsumedCode),
    })
  );

  if (normalizedCode) {
    await markRevoked(customerId, normalizedCode);
    console.log(
      JSON.stringify({
        message: "Guide50 code marked revoked",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(normalizedCode),
      })
    );
  }
  if (!state.guide50Code || !state.guide50IssuedAt || !state.guide50ExpiresAt) {
    console.warn(
      JSON.stringify({
        message: "Guide50 consume skipped",
        reason: "NO_ACTIVE_GUIDE50",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(normalizedCode),
      })
    );
    return { consumed: Boolean(normalizedCode), stateCleared: false, reason: "NO_ACTIVE_GUIDE50" };
  }
  if (!normalizedCode || normalizedCode !== currentCode) {
    console.warn(
      JSON.stringify({
        message: "Guide50 consume skipped",
        reason: "CODE_MISMATCH",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(normalizedCode),
        activeCodeMasked: maskCouponCode(currentCode),
      })
    );
    return { consumed: true, stateCleared: false, reason: "CODE_MISMATCH" };
  }

  await setGuide50ConsumedFields(customerId, {
    code: state.guide50Code,
    issuedAt: state.guide50IssuedAt,
    expiresAt: state.guide50ExpiresAt,
    discountId: state.guide50DiscountId,
    orderId: params.orderId,
    consumedAt: params.consumedAt ?? Math.floor(Date.now() / 1000),
  });
  await clearGuide50Fields(customerId);

  console.log(
    JSON.stringify({
      message: "Guide50 consume snapshot saved",
      orderId: params.orderId,
      customerIdMasked: maskCustomerId(customerId),
      codeMasked: maskCouponCode(state.guide50Code),
      consumedExpiresAt: state.guide50ExpiresAt,
      consumedAt: params.consumedAt ?? Math.floor(Date.now() / 1000),
      stateCleared: true,
    })
  );

  return { consumed: true, stateCleared: true };
}

export async function restoreGuide50ForOrder(params: {
  admin: AdminApiContext;
  customerId: string;
  orderId: string;
  now?: number;
}): Promise<Guide50RestoreResult> {
  const customerId = normalizeCustomerId(params.customerId);
  if (!customerId) {
    console.warn(
      JSON.stringify({
        message: "Guide50 restore skipped",
        reason: "CUSTOMER_ID_INVALID",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(params.customerId),
      })
    );
    return { restored: false, reason: "CUSTOMER_ID_INVALID" };
  }

  const state = await getState(customerId);
  console.log(
    JSON.stringify({
      message: "Guide50 restore check",
      orderId: params.orderId,
      customerIdMasked: maskCustomerId(customerId),
      hasConsumedGuide50: Boolean(state.guide50ConsumedCode),
      consumedCodeMasked: maskCouponCode(state.guide50ConsumedCode),
      consumedOrderId: state.guide50ConsumedOrderId,
      consumedExpiresAt: state.guide50ConsumedExpiresAt,
      activeCodeMasked: maskCouponCode(state.guide50Code),
    })
  );
  if (!state.guide50ConsumedCode || !state.guide50ConsumedExpiresAt) {
    console.log(
      JSON.stringify({
        message: "Guide50 restore skipped",
        reason: "NO_CONSUMED_GUIDE50",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
      })
    );
    return { restored: false, reason: "NO_CONSUMED_GUIDE50" };
  }
  if (state.guide50ConsumedOrderId !== params.orderId) {
    console.warn(
      JSON.stringify({
        message: "Guide50 restore skipped",
        reason: "ORDER_MISMATCH",
        orderId: params.orderId,
        consumedOrderId: state.guide50ConsumedOrderId,
        customerIdMasked: maskCustomerId(customerId),
      })
    );
    return { restored: false, reason: "ORDER_MISMATCH" };
  }

  const nowSec = params.now ?? Math.floor(Date.now() / 1000);
  if (state.guide50ConsumedExpiresAt <= nowSec) {
    console.warn(
      JSON.stringify({
        message: "Guide50 restore skipped",
        reason: "EXPIRED",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        consumedExpiresAt: state.guide50ConsumedExpiresAt,
        nowSec,
      })
    );
    return { restored: false, reason: "EXPIRED", expiresAt: state.guide50ConsumedExpiresAt };
  }

  console.log(
    JSON.stringify({
      message: "Guide50 restore issuing replacement",
      orderId: params.orderId,
      customerIdMasked: maskCustomerId(customerId),
      originalCodeMasked: maskCouponCode(state.guide50ConsumedCode),
      restoredExpiresAt: state.guide50ConsumedExpiresAt,
      ttlSeconds: state.guide50ConsumedExpiresAt - nowSec,
    })
  );
  const result = await issueGuide50(params.admin, customerId, {
    force: true,
    expiresAt: state.guide50ConsumedExpiresAt,
  });
  if (!result.code) {
    console.error(
      JSON.stringify({
        message: "Guide50 restore issue failed",
        reason: "ISSUE_FAILED",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        restoredExpiresAt: state.guide50ConsumedExpiresAt,
      })
    );
    return { restored: false, reason: "ISSUE_FAILED", expiresAt: state.guide50ConsumedExpiresAt };
  }

  await clearGuide50ConsumedFields(customerId);
  console.log(
    JSON.stringify({
      message: "Guide50 restore completed",
      orderId: params.orderId,
      customerIdMasked: maskCustomerId(customerId),
      newCodeMasked: maskCouponCode(result.code),
      restoredExpiresAt: state.guide50ConsumedExpiresAt,
      consumedSnapshotCleared: true,
    })
  );
  return { restored: true, code: result.code, expiresAt: state.guide50ConsumedExpiresAt };
}
