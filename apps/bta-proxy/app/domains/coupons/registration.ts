import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { acquireLock, releaseLock } from "./lock";
import { getState, patchState } from "./state";
import { issueGuide50 } from "./issuer";
import { listRevoked } from "./revoked";
import { assertUnusedExpiredLegacyOffer } from "./legacyRegistrationRecovery";

const WELCOME_WINDOW_SECONDS = 24 * 60 * 60;

export async function activateRegistrationGuide50(admin: AdminApiContext, customerId: string) {
  if (!(await acquireLock("guide50Registration", customerId, 60))) {
    throw new Error("Registration offer is being activated. Please retry.");
  }
  try {
    const state = await getState(customerId);
    if (!state.webRegisteredAt) {
      await patchState(customerId, { webRegisteredAt: Math.floor(Date.now() / 1000) });
    }
    if (
      !state.guide50RecoveryCompleted &&
      state.guide50RecoveryCode &&
      state.guide50RecoveryEvidence
    ) {
      await assertUnusedExpiredLegacyOffer(admin, customerId, state, state.guide50RecoveryCode);
      const startedAt = state.guide50RecoveryStartedAt || Math.floor(Date.now() / 1000);
      await patchState(customerId, { guide50RecoveryStartedAt: startedAt });
      const expiresAt = startedAt + WELCOME_WINDOW_SECONDS;
      if (expiresAt <= Math.floor(Date.now() / 1000)) {
        return { issued: false, reason: "RECOVERY_EXPIRED" };
      }
      const result = await issueGuide50(admin, customerId, { force: true, expiresAt });
      if (!result.code) {
        throw new Error("Recovery offer unavailable");
      }
      await patchState(customerId, {
        guide50RecoveryCompleted: true,
        guide50RegistrationIssued: true,
      });
      return { issued: result.issued, expiresAt, recovered: true };
    }
    const revoked = await listRevoked(customerId);
    const hadRevokedWelcomeOffer = [...revoked].some((code) => code.startsWith("GUIDE50-"));
    if (
      state.guide50RegistrationIssued ||
      state.guide50Code ||
      state.guide50ConsumedCode ||
      hadRevokedWelcomeOffer
    ) {
      // Never renew an existing, consumed, expired, or manually revoked offer.
      await patchState(customerId, { guide50RegistrationIssued: true });
      return { issued: false, reason: "ALREADY_ISSUED" };
    }
    const registeredAt = state.guide50RegisteredAt ?? Math.floor(Date.now() / 1000);
    await patchState(customerId, { guide50RegisteredAt: registeredAt });
    const expiresAt = registeredAt + WELCOME_WINDOW_SECONDS;
    if (expiresAt <= Math.floor(Date.now() / 1000)) {
      return { issued: false, reason: "EXPIRED" };
    }
    const result = await issueGuide50(admin, customerId, { expiresAt });
    if (!result.code) {
      throw new Error("Registration offer issuance failed. Please retry.");
    }
    await patchState(customerId, { guide50RegistrationIssued: true });
    return { issued: result.issued, expiresAt };
  } finally {
    await releaseLock("guide50Registration", customerId);
  }
}
