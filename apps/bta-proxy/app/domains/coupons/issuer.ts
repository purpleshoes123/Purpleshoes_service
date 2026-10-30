import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { acquireLock, releaseLock } from "./lock";
import {
  clearExtra10Fields,
  clearGuide50Fields,
  getState,
  setExtra10Fields,
  setGuide50Fields,
} from "./state";
import { normalizeCustomerId, normalizeCode } from "./normalize";
import {
  createGuide50DiscountCode,
  createExtra10DiscountCode,
  deactivateDiscountCode,
  fetchDiscountIdByCode,
  fetchDiscountStatusByCode,
} from "./shopifyDiscounts";
import { markRevoked, unmarkRevoked } from "./revoked";
import { resolveActiveExtra10 } from "./extra10Availability";

function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

function buildGuide50Code(customerId: string): string {
  const ts = formatTimestamp(new Date());
  return `GUIDE50-${customerId}-${ts}`;
}

function buildExtra10Code(customerId: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `EXTRA10-${customerId}-${ts}-${rand}`;
}

export type IssueResult = {
  code: string | null;
  discountId: string | null;
  issued: boolean;
  reason?: string;
};

export async function issueGuide50(
  admin: AdminApiContext,
  customerIdRaw: string,
  options: { force?: boolean; expiresAt?: number } = {},
): Promise<IssueResult> {
  const customerId = normalizeCustomerId(customerIdRaw);
  if (!customerId) {
    throw new Error("customerId is required");
  }

  const lockOk = await acquireLock("issueGuide50", customerId, 10);
  if (!lockOk) {
    return { code: null, discountId: null, issued: false, reason: "LOCKED" };
  }

  try {
    const state = await getState(customerId);
    if (state.guide50Code && !options.force) {
      return {
        code: state.guide50Code,
        discountId: state.guide50DiscountId || null,
        issued: false,
        reason: "ALREADY_ISSUED",
      };
    }

    const now = Date.now();
    const issuedAt = Math.floor(now / 1000);
    const expiresAt = options.expiresAt ?? Math.floor((now + 24 * 60 * 60 * 1000) / 1000);
    const code = buildGuide50Code(customerId);
    const discount = await createGuide50DiscountCode(admin, {
      code,
      endsAt: new Date(expiresAt * 1000).toISOString(),
    });

    await setGuide50Fields(customerId, {
      code: discount.code,
      issuedAt,
      expiresAt,
      discountId: discount.discountId,
    });
    await unmarkRevoked(customerId, discount.code);

    return {
      code: discount.code,
      discountId: discount.discountId,
      issued: true,
    };
  } finally {
    await releaseLock("issueGuide50", customerId);
  }
}

export async function issueExtra10(
  admin: AdminApiContext,
  customerIdRaw: string,
  options: { force?: boolean } = {},
): Promise<IssueResult> {
  const customerId = normalizeCustomerId(customerIdRaw);
  if (!customerId) {
    throw new Error("customerId is required");
  }

  const lockOk = await acquireLock("issueExtra10", customerId, 10);
  if (!lockOk) {
    return { code: null, discountId: null, issued: false, reason: "LOCKED" };
  }

  try {
    const state = await getState(customerId);
    const activeExtra10 = options.force
      ? null
      : await resolveActiveExtra10({
          admin,
          customerId,
          state,
        });
    if (activeExtra10?.available && activeExtra10.code && !options.force) {
      return {
        code: activeExtra10.code,
        discountId: state.extra10DiscountId || null,
        issued: false,
        reason: "ALREADY_ISSUED",
      };
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const code = buildExtra10Code(customerId);
    const discount = await createExtra10DiscountCode(admin, { code });

    await setExtra10Fields(customerId, {
      code: discount.code,
      issuedAt,
      discountId: discount.discountId,
    });
    await unmarkRevoked(customerId, discount.code);

    return {
      code: discount.code,
      discountId: discount.discountId,
      issued: true,
    };
  } finally {
    await releaseLock("issueExtra10", customerId);
  }
}

export async function revokeCode(
  admin: AdminApiContext,
  customerIdRaw: string,
  codeRaw: string,
  discountId?: string | null,
): Promise<void> {
  const customerId = normalizeCustomerId(customerIdRaw);
  if (!customerId) {
    throw new Error("customerId is required");
  }

  const code = normalizeCode(codeRaw);
  if (!code) {
    throw new Error("code is required");
  }

  let resolvedId = discountId || null;
  if (!resolvedId) {
    resolvedId = await fetchDiscountIdByCode(admin, code);
  }
  if (resolvedId) {
    await deactivateDiscountCode(admin, resolvedId);
  } else {
    const status = await fetchDiscountStatusByCode(admin, code);
    if (status.status === "unknown") {
      throw new Error("discountId not found; cannot revoke without lookup support");
    }
  }

  await markRevoked(customerId, code);

  if (code.startsWith("GUIDE50")) {
    await clearGuide50Fields(customerId);
  } else if (code.startsWith("EXTRA10")) {
    await clearExtra10Fields(customerId);
  }
}
