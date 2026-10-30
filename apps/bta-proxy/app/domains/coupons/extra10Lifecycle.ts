import { clearExtra10Fields, getState } from "./state";
import { markRevoked } from "./revoked";
import { normalizeCode, normalizeCustomerId } from "./normalize";
import { maskCouponCode, maskCustomerId } from "./logging";

export type Extra10ConsumeResult = {
  consumed: boolean;
  stateCleared: boolean;
  reason?: "CUSTOMER_ID_INVALID" | "NO_ACTIVE_EXTRA10" | "CODE_MISMATCH";
};

export async function consumeExtra10ForOrder(params: {
  customerId: string;
  orderId: string;
  code: string;
}): Promise<Extra10ConsumeResult> {
  const customerId = normalizeCustomerId(params.customerId);
  if (!customerId) {
    console.warn(
      JSON.stringify({
        message: "Extra10 consume skipped",
        reason: "CUSTOMER_ID_INVALID",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(params.customerId),
        codeMasked: maskCouponCode(params.code),
      }),
    );
    return { consumed: false, stateCleared: false, reason: "CUSTOMER_ID_INVALID" };
  }

  const state = await getState(customerId);
  const normalizedCode = normalizeCode(params.code);
  const currentCode = normalizeCode(state.extra10Code);

  console.log(
    JSON.stringify({
      message: "Extra10 consume check",
      orderId: params.orderId,
      customerIdMasked: maskCustomerId(customerId),
      codeMasked: maskCouponCode(normalizedCode),
      hasActiveExtra10: Boolean(state.extra10Code),
      hasIssuedAt: Boolean(state.extra10IssuedAt),
      activeCodeMasked: maskCouponCode(state.extra10Code),
      shareActivated: state.extra10ShareActivated,
      shareActivatedAt: state.extra10ShareActivatedAt,
    }),
  );

  if (normalizedCode) {
    await markRevoked(customerId, normalizedCode);
    console.log(
      JSON.stringify({
        message: "Extra10 code marked revoked",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(normalizedCode),
      }),
    );
  }

  if (!state.extra10Code || !state.extra10IssuedAt) {
    console.warn(
      JSON.stringify({
        message: "Extra10 consume skipped",
        reason: "NO_ACTIVE_EXTRA10",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(normalizedCode),
      }),
    );
    return { consumed: Boolean(normalizedCode), stateCleared: false, reason: "NO_ACTIVE_EXTRA10" };
  }

  if (!normalizedCode || normalizedCode !== currentCode) {
    console.warn(
      JSON.stringify({
        message: "Extra10 consume skipped",
        reason: "CODE_MISMATCH",
        orderId: params.orderId,
        customerIdMasked: maskCustomerId(customerId),
        codeMasked: maskCouponCode(normalizedCode),
        activeCodeMasked: maskCouponCode(currentCode),
      }),
    );
    return { consumed: true, stateCleared: false, reason: "CODE_MISMATCH" };
  }

  await clearExtra10Fields(customerId);

  console.log(
    JSON.stringify({
      message: "Extra10 active state cleared",
      orderId: params.orderId,
      customerIdMasked: maskCustomerId(customerId),
      codeMasked: maskCouponCode(state.extra10Code),
      stateCleared: true,
    }),
  );

  return { consumed: true, stateCleared: true };
}
