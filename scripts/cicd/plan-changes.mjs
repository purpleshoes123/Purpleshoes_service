import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const backendPrefix = "apps/bta-proxy/";
const appPrefix = "shopify/bta-proxy/";
const themePrefix = "themes/kpurpleshoes-theme/";
const backendBuildInputs = new Set([
  "scripts/cicd/package-runtime.sh",
  "scripts/cicd/stage-runtime.mjs",
  "scripts/cicd/archive-runtime.mjs",
  "scripts/cicd/plan-changes.mjs",
]);
const testPath = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function runtimeSourcePath(file) {
  if (!file.startsWith(backendPrefix) || testPath.test(file)) {
    return false;
  }
  const name = file.slice(backendPrefix.length);
  if (!name.startsWith("public/") && name.endsWith(".md")) {
    return false;
  }
  return /^(app\/|public\/|prisma\/|scripts\/|mail-templates\/|certs\/|package(?:-lock)?\.json$|vite\.config\.ts$|react-router\.config\.ts$|tsconfig\.json$|env\.d\.ts$)/.test(
    name,
  );
}

export function classifyChanges(paths) {
  const backend = paths.filter((file) => runtimeSourcePath(file) || backendBuildInputs.has(file));
  const theme = paths.filter(
    (file) =>
      file.startsWith(themePrefix) &&
      /^(assets|config|layout|locales|sections|snippets|templates)\//.test(
        file.slice(themePrefix.length),
      ),
  );
  const app = paths.filter((file) => {
    if (!file.startsWith(appPrefix) || testPath.test(file) || file.endsWith(".md")) {
      return false;
    }
    const name = file.slice(appPrefix.length);
    return /^(extensions\/|shopify\.app\.toml$|package(?:-lock)?\.json$|tsconfig\.json$)/.test(
      name,
    );
  });
  return { backend, theme, app };
}

function revision(value) {
  if (!/^[a-f0-9]{40}$/.test(value || "")) {
    throw Error("A complete Git revision is required");
  }
  return value;
}

export function componentChanges(base, head, cwd) {
  const files = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", revision(base), revision(head), "--"],
    { encoding: "utf8", cwd },
  )
    .split("\0")
    .filter(Boolean);
  return classifyChanges(files);
}

export function successfulBaseline(runs, currentRunId) {
  const run = runs.find(
    (item) =>
      String(item.id) !== String(currentRunId) &&
      item.head_branch === "main" &&
      item.status === "completed" &&
      item.conclusion === "success" &&
      ["push", "workflow_dispatch"].includes(item.event),
  );
  if (!run) {
    throw Error("No verified successful main deployment baseline is available");
  }
  return revision(run.head_sha);
}

async function workflowBaseline() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    return revision(event.pull_request.base.sha);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) {
    throw Error("Invalid workflow repository");
  }
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/production.yml/runs?branch=main&status=success&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) {
    throw Error(`Cannot read the successful deployment baseline (HTTP ${response.status})`);
  }
  const body = await response.json();
  return successfulBaseline(body.workflow_runs, process.env.GITHUB_RUN_ID);
}

async function main() {
  const args = process.argv.slice(2);
  const argument = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const base = argument("--base") || (await workflowBaseline());
  const head = argument("--head") || process.env.GITHUB_SHA;
  const result = componentChanges(base, head);
  const component = argument("--component");
  if (component) {
    if (!["backend", "theme", "app"].includes(component)) {
      throw Error("Unknown deployment component");
    }
    process.stdout.write(JSON.stringify(result[component]));
    return;
  }
  const flags = Object.fromEntries(
    Object.entries(result).map(([key, files]) => [key, files.length > 0]),
  );
  flags.deploy = Object.values(flags).some(Boolean);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(flags)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  console.log(
    JSON.stringify({
      base,
      head,
      ...flags,
      files: Object.fromEntries(Object.entries(result).map(([key, files]) => [key, files.length])),
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
