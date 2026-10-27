export type SessionLimitEntitlements = {
  BUNDLE: string | null;
};

const DEFAULT_ONLY_MAX_ACTIVE_SESSIONS = 2;
const DEFAULT_KIT_MAX_ACTIVE_SESSIONS = 3;

function positiveIntegerOrDefault(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * Guide plan device policy:
 * - Guidebook Only (PDF or VIDEO): 2 devices
 * - Guide Kit (BUNDLE): 3 devices
 *
 * The environment variables retain an operational override without changing
 * the product policy in application code.
 */
export function resolveGuideSessionLimit(
  entitlements: SessionLimitEntitlements | null,
  now: Date,
  env: Record<string, string | undefined> = process.env
): number {
  const onlyLimit = positiveIntegerOrDefault(
    env.GKV_MAX_ACTIVE_SESSIONS,
    DEFAULT_ONLY_MAX_ACTIVE_SESSIONS
  );
  const kitLimit = positiveIntegerOrDefault(
    env.GKV_MAX_ACTIVE_SESSIONS_BUNDLE,
    DEFAULT_KIT_MAX_ACTIVE_SESSIONS
  );

  const bundleExpiresAt = entitlements?.BUNDLE;
  const bundleIsActive =
    typeof bundleExpiresAt === "string" &&
    !Number.isNaN(new Date(bundleExpiresAt).getTime()) &&
    new Date(bundleExpiresAt).getTime() > now.getTime();

  return bundleIsActive ? kitLimit : onlyLimit;
}
