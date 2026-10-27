import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { createHash } from "crypto";
import { ErrorCode } from "~/lib/errors";
import { normalizeCustomerId } from "./normalize";
import { acquireLock, releaseLock } from "./lock";
import { getState, setExtra10ShareActivated } from "./state";
import { issueExtra10 } from "./issuer";
import { getCouponRedisClient } from "./redisClient";
import { memoryGet, memorySet } from "./memoryStore";
import { resolveActiveExtra10 } from "./extra10Availability";

export type Extra10ShareActivationResult = {
  activated: boolean;
  alreadyActivated: boolean;
  coupon: {
    type: "extra10";
    available: boolean;
    amount: 10;
  };
  warnings: string[];
};

export class Extra10ShareActivationError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message);
    this.name = "Extra10ShareActivationError";
    this.code = code;
  }
}

type IdempotencyEntry = {
  payloadHash: string;
  result: Extra10ShareActivationResult;
};

const IDEM_TTL_SECONDS = 6 * 60 * 60;

function buildIdempotencyKey(customerId: string, clientRequestId: string): string {
  return `coupon:extra10:activate-share:${customerId}:${clientRequestId}`;
}

function hashPayload(payload: {
  shareUrl: string;
  source: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
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

async function buildCouponAvailability(params: {
  admin: AdminApiContext;
  customerId: string;
}): Promise<boolean> {
  const { admin, customerId } = params;
  const state = await getState(customerId);
  const availability = await resolveActiveExtra10({
    admin,
    customerId,
    state,
  });

  return availability.available;
}

async function resolveExistingIdempotentResult(params: {
  admin: AdminApiContext;
  customerId: string;
  clientRequestId?: string;
  payload: { shareUrl: string; source: string };
}): Promise<Extra10ShareActivationResult | null> {
  if (!params.clientRequestId) return null;

  const payloadHash = hashPayload(params.payload);
  const entry = await getIdempotencyEntry(params.customerId, params.clientRequestId);
  if (!entry) return null;

  if (entry.payloadHash !== payloadHash) {
    throw new Extra10ShareActivationError(
      ErrorCode.INTERNAL_CONFLICT,
      "동일한 clientRequestId에 다른 입력을 사용할 수 없습니다."
    );
  }

  if (entry.result.coupon.available) {
    const available = await buildCouponAvailability({
      admin: params.admin,
      customerId: params.customerId,
    });
    if (!available) {
      console.warn(
        JSON.stringify({
          message: "Extra10 share idempotent result bypassed",
          customerId: params.customerId,
          clientRequestId: params.clientRequestId,
        })
      );
      return null;
    }
  }

  return entry.result;
}

export async function activateExtra10Share(params: {
  admin: AdminApiContext;
  customerId: string;
  payload: {
    shareUrl: string;
    source: string;
    clientRequestId?: string;
  };
}): Promise<Extra10ShareActivationResult> {
  const customerId = normalizeCustomerId(params.customerId);
  if (!customerId) {
    throw new Extra10ShareActivationError(
      ErrorCode.VALIDATION_ERROR,
      "customerId가 유효하지 않습니다."
    );
  }

  const existing = await resolveExistingIdempotentResult({
    admin: params.admin,
    customerId,
    clientRequestId: params.payload.clientRequestId,
    payload: {
      shareUrl: params.payload.shareUrl,
      source: params.payload.source,
    },
  });
  if (existing) {
    return existing;
  }

  const locked = await acquireLock("extra10ActivateShare", customerId, 30);
  if (!locked) {
    throw new Extra10ShareActivationError(ErrorCode.INTERNAL_CONFLICT);
  }

  try {
    const retryExisting = await resolveExistingIdempotentResult({
      admin: params.admin,
      customerId,
      clientRequestId: params.payload.clientRequestId,
      payload: {
        shareUrl: params.payload.shareUrl,
        source: params.payload.source,
      },
    });
    if (retryExisting) {
      return retryExisting;
    }

    const state = await getState(customerId);
    let result: Extra10ShareActivationResult;
    const hasAvailableCoupon = await buildCouponAvailability({
      admin: params.admin,
      customerId,
    });

    if (hasAvailableCoupon) {
      result = {
        activated: false,
        alreadyActivated: true,
        coupon: {
          type: "extra10",
          available: true,
          amount: 10,
        },
        warnings: [],
      };
    } else {
      const issueResult = await issueExtra10(params.admin, customerId);
      if (issueResult.reason === "LOCKED") {
        throw new Extra10ShareActivationError(ErrorCode.INTERNAL_CONFLICT);
      }

      await setExtra10ShareActivated(customerId, Math.floor(Date.now() / 1000));
      const available = await buildCouponAvailability({
        admin: params.admin,
        customerId,
      });
      const warnings = available
        ? []
        : state.extra10ShareActivated
          ? ["EXTRA10_REISSUE_NOT_AVAILABLE"]
          : ["EXTRA10_NOT_AVAILABLE"];
      result = {
        activated: true,
        alreadyActivated: false,
        coupon: {
          type: "extra10",
          available,
          amount: 10,
        },
        warnings,
      };
    }

    if (params.payload.clientRequestId) {
      await setIdempotencyEntry(customerId, params.payload.clientRequestId, {
        payloadHash: hashPayload({
          shareUrl: params.payload.shareUrl,
          source: params.payload.source,
        }),
        result,
      });
    }

    console.log(
      JSON.stringify({
        message: "Extra10 share activation processed",
        customerId,
        source: params.payload.source,
        shareUrl: params.payload.shareUrl,
        activated: result.activated,
        alreadyActivated: result.alreadyActivated,
        issuedAfterPriorActivation: state.extra10ShareActivated && result.activated,
        couponAvailable: result.coupon.available,
        warnings: result.warnings,
      })
    );

    return result;
  } finally {
    await releaseLock("extra10ActivateShare", customerId);
  }
}
