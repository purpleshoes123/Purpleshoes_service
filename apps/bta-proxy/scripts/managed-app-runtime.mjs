import { RUNTIME_KEYS, selectRuntimeSettings } from "./app-runtime-settings.mjs";

const allowed = new Set(RUNTIME_KEYS);
const failure = () => new Error("Managed application runtime configuration failed");

// Values stay in memory. A pinned version makes server replacement reproducible.
export async function resolveManagedAppRuntime({ env, readSecret, backgroundJob = false }) {
  const secretId = env.APP_RUNTIME_SECRET_ARN?.trim();
  if (!secretId && env.DEPLOYMENT_MODE !== "multi-node") {
    return { ...env };
  }
  try {
    const arn =
      /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:purpleshoes\/prod\/app-runtime-[A-Za-z0-9]{6}$/.exec(
        secretId || "",
      );
    const databaseArn = /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:/.exec(
      env.DATABASE_SECRET_ARN || "",
    );
    const versionId = env.APP_RUNTIME_SECRET_VERSION;
    if (
      env.DEPLOYMENT_MODE !== "multi-node" ||
      !arn ||
      !databaseArn ||
      arn[1] !== databaseArn[1] ||
      arn[2] !== databaseArn[2] ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(versionId || "") ||
      !["prelive", "active"].includes(env.FLEET_STAGE) ||
      (backgroundJob && env.FLEET_STAGE !== "active")
    ) {
      throw failure();
    }
    const response = await readSecret(secretId, versionId);
    if (
      response.ARN !== secretId ||
      response.VersionId !== versionId ||
      !response.VersionStages?.includes("AWSCURRENT") ||
      typeof response.SecretString !== "string"
    ) {
      throw failure();
    }
    const settings = JSON.parse(response.SecretString);
    if (
      !settings ||
      Array.isArray(settings) ||
      typeof settings !== "object" ||
      Object.entries(settings).some(
        ([key, value]) => !allowed.has(key) || typeof value !== "string",
      )
    ) {
      throw failure();
    }
    const selected = selectRuntimeSettings(settings);
    const result = { ...env, ...selected };
    // Never run startup reconstruction on an ASG replacement instance.
    result.REBUILD_AUTO_ON_STARTUP = "false";
    result.REBUILD_AUTO_IF_EMPTY = "false";
    if (env.FLEET_STAGE === "prelive") {
      result.PURCHASE_EMAIL_ENABLED = "false";
      result.PURCHASE_SERVICE_EMAIL_ENABLED = "false";
      result.KLAVIYO_PURCHASE_EVENT_ENABLED = "false";
      result.KLAVIYO_MAIL_EVENT_ENABLED = "false";
    }
    return result;
  } catch {
    // Neither SDK errors nor invalid values may appear in startup logs.
    throw failure();
  }
}
