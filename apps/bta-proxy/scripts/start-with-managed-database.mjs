import { spawn } from "node:child_process";
import { once } from "node:events";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { PrismaClient } from "@prisma/client";
import { createDatabaseCredentialResolver } from "./managed-database.mjs";
import { databaseUrlWithVerifiedTls } from "./database-tls.mjs";
import { assertMultiNodeConfiguration } from "./multi-node-config.mjs";
import Redis from "ioredis";
import { resolveManagedValkey } from "./managed-valkey.mjs";
import { resolveManagedAppRuntime } from "./managed-app-runtime.mjs";

// Refuse local/in-memory configuration on the new ASG fleet. Legacy startup is unchanged.
assertMultiNodeConfiguration(process.env);

const secretId = process.env.DATABASE_SECRET_ARN?.trim();
const redisSecretId = process.env.REDIS_SECRET_ARN?.trim();
const appRuntimeSecretId = process.env.APP_RUNTIME_SECRET_ARN?.trim();
let runtimeEnv = { ...process.env };
const worker = process.argv.includes("--purchase-worker");
const reconcile = process.argv.includes("--purchase-reconcile");
const secretClient =
  secretId || redisSecretId || appRuntimeSecretId
    ? new SecretsManagerClient({
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
        maxAttempts: 3,
      })
    : null;
const refresh = createDatabaseCredentialResolver({
  databaseUrl: databaseUrlWithVerifiedTls(process.env.DATABASE_URL),
  secretId,
  readSecret: (id) =>
    secretClient.send(
      new GetSecretValueCommand({
        SecretId: id,
        VersionStage: "AWSCURRENT",
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    ),
  probe: async (url) => {
    const probeUrl = new URL(url);
    probeUrl.searchParams.set("connect_timeout", "10");
    probeUrl.searchParams.set("pool_timeout", "10");
    const client = new PrismaClient({ datasourceUrl: probeUrl.toString(), log: [] });
    try {
      await client.$queryRaw`SELECT 1`;
    } finally {
      await client.$disconnect();
    }
  },
});
let child;
let stopping = false;
let restarting = false;
let timer;
let rotating = false;

async function stopChild() {
  const target = child;
  if (!target || target.exitCode !== null || target.signalCode !== null) {
    return;
  }
  const exited = once(target, "exit");
  target.kill("SIGTERM");
  // Worker drains an in-flight SMTP send (60s socket timeout) before exit.
  const force = setTimeout(() => target.kill("SIGKILL"), worker ? 90000 : 15000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}
function startChild(url) {
  const args = reconcile
    ? [
        "--import",
        "tsx",
        "scripts/purchase-email-reconcile.ts",
        ...process.argv.slice(2).filter((arg) => arg !== "--purchase-reconcile"),
      ]
    : worker
      ? ["--import", "tsx", "scripts/purchase-email-worker.ts", "--watch"]
      : ["node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"];
  child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...runtimeEnv, NODE_ENV: "production", ...(url ? { DATABASE_URL: url } : {}) },
  });
  child.once("error", () => {
    console.error("Application process could not start");
    process.exitCode = 1;
    stopping = true;
    clearInterval(timer);
    secretClient?.destroy();
  });
  child.once("exit", (code) => {
    if (!stopping && !restarting) {
      stopping = true;
      clearInterval(timer);
      secretClient?.destroy();
      process.exitCode = reconcile ? (code ?? 1) : code || 1; // PM2 restarts through fresh credentials.
    }
  });
}
async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(timer);
  await stopChild();
  secretClient?.destroy();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  runtimeEnv = await resolveManagedAppRuntime({
    env: process.env,
    backgroundJob: worker || reconcile,
    readSecret: (id, versionId) =>
      secretClient.send(
        new GetSecretValueCommand({
          SecretId: id,
          VersionId: versionId,
          VersionStage: "AWSCURRENT",
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      ),
  });
  const redisUrl = await resolveManagedValkey({
    redisUrl: process.env.REDIS_URL,
    secretId: redisSecretId,
    readSecret: (id) =>
      secretClient.send(
        new GetSecretValueCommand({
          SecretId: id,
          VersionStage: "AWSCURRENT",
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      ),
    probe: async (url) => {
      const client = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 5000,
        commandTimeout: 5000,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
        tls: { rejectUnauthorized: true },
      });
      client.on("error", () => {}); // Errors are normalized by the resolver, never printed.
      try {
        await client.connect();
        if ((await client.ping()) !== "PONG") {
          throw new Error();
        }
        const role = await client.role();
        if (!Array.isArray(role) || role[0] !== "master") {
          throw new Error();
        }
      } finally {
        client.disconnect();
      }
    },
  });
  if (redisUrl !== undefined) {
    runtimeEnv.REDIS_URL = redisUrl;
  }
  assertMultiNodeConfiguration(runtimeEnv);
  const initial = await refresh();
  if (!stopping) {
    startChild(initial.url);
  }
  if (secretId && !stopping && !reconcile) {
    timer = setInterval(async () => {
      if (rotating || stopping) {
        return;
      }
      rotating = true;
      try {
        const latest = await refresh();
        if (latest.changed && !stopping) {
          restarting = true;
          await stopChild();
          if (!stopping) {
            startChild(latest.url);
          }
          restarting = false;
          console.info("Managed database credentials refreshed");
        }
      } catch {
        console.warn("Managed database refresh failed; retaining the running process");
      } finally {
        rotating = false;
      }
    }, 60000);
  }
} catch {
  console.error("Managed service startup failed; no application was started");
  secretClient?.destroy();
  process.exitCode = 1;
}
