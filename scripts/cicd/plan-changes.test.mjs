import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  classifyChanges,
  componentChanges,
  runtimeSourcePath,
  successfulBaseline,
  executionPlan,
} from "./plan-changes.mjs";

test("documents, tests and CI verification do not trigger an application deployment", () => {
  assert.deepEqual(
    classifyChanges([
      "README.md",
      "docs/maintenance/OPERATIONS.md",
      ".github/workflows/production.yml",
      "scripts/cicd/test_deploy.py",
      "scripts/cicd/plan-changes.test.mjs",
      "apps/bta-proxy/README.md",
      "apps/bta-proxy/app/domains/mail/send.test.ts",
      "apps/bta-proxy/app/__tests__/integration.ts",
      "shopify/bta-proxy/extensions/order/README.md",
      "shopify/bta-proxy/extensions/order/src/index.test.tsx",
    ]),
    { backend: [], theme: [], app: [] },
  );
});

test("backend tests still run when only tests changed, without building or deploying runtime", () => {
  assert.deepEqual(executionPlan(["apps/bta-proxy/app/domains/checkout/price.test.ts"]), {
    backend: false,
    theme: false,
    app: false,
    backend_verify: true,
    deploy: false,
  });
  assert.deepEqual(executionPlan(["docs/maintenance/OPERATIONS.md"]), {
    backend: false,
    theme: false,
    app: false,
    backend_verify: false,
    deploy: false,
  });
});

test("each production source is routed only to its corresponding component", () => {
  const backend = [
    "apps/bta-proxy/app/routes/v1.ready.ts",
    "apps/bta-proxy/scripts/purchase-email-worker.ts",
    "apps/bta-proxy/package-lock.json",
    "apps/bta-proxy/public/help.md",
    "apps/bta-proxy/mail-templates/receipt.html",
    "apps/bta-proxy/prisma/migrations/new.sql",
    "scripts/cicd/stage-runtime.mjs",
  ];
  const theme = [
    "themes/kpurpleshoes-theme/assets/member-guide.js",
    "themes/kpurpleshoes-theme/sections/header.liquid",
    "themes/kpurpleshoes-theme/locales/en.default.json",
  ];
  const app = [
    "shopify/bta-proxy/shopify.app.toml",
    "shopify/bta-proxy/package-lock.json",
    "shopify/bta-proxy/extensions/order/src/index.tsx",
    "shopify/bta-proxy/extensions/order/shopify.extension.toml",
  ];
  assert.deepEqual(classifyChanges([...backend, ...theme, ...app]), { backend, theme, app });
  assert.equal(runtimeSourcePath("apps/bta-proxy/.env.example"), false);
  assert.equal(runtimeSourcePath("scripts/cicd/stage-runtime.mjs"), false);
});

test("the baseline must be a completed successful main production run", () => {
  const valid = {
    id: 1,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: "a".repeat(40),
  };
  assert.equal(
    successfulBaseline(
      [
        { ...valid, id: 4, conclusion: "failure" },
        { ...valid, id: 3, event: "pull_request" },
        { ...valid, id: 2 },
        valid,
      ],
      "2",
    ),
    valid.head_sha,
  );
  assert.throws(() => successfulBaseline([], "2"), /No verified/);
  assert.throws(
    () => successfulBaseline([{ ...valid, head_sha: "unsafe revision" }], "2"),
    /complete Git revision/,
  );
});

test("real Git diffs retain unshipped source after a failed push and detect source moved into docs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ps-plan-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (message) => {
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(cwd, "apps/bta-proxy/app"), { recursive: true });
    writeFileSync(join(cwd, "apps/bta-proxy/app/route.ts"), "export const value = 1;\n");
    const baseline = commit("initial");
    writeFileSync(join(cwd, "README.md"), "Documentation only\n");
    const docs = commit("docs");
    assert.deepEqual(componentChanges(baseline, docs, cwd), { backend: [], theme: [], app: [] });
    writeFileSync(join(cwd, "apps/bta-proxy/app/route.ts"), "export const value = 2;\n");
    const failed = commit("source awaiting deployment");
    writeFileSync(join(cwd, "README.md"), "Another documentation change\n");
    const head = commit("docs after failed deployment");
    assert.deepEqual(componentChanges(baseline, head, cwd).backend, [
      "apps/bta-proxy/app/route.ts",
    ]);
    assert.deepEqual(componentChanges(failed, head, cwd).backend, []);
    assert.deepEqual(componentChanges(head, head, cwd), { backend: [], theme: [], app: [] });
    renameSync(join(cwd, "apps/bta-proxy/app/route.ts"), join(cwd, "removed-source.md"));
    const moved = commit("remove source");
    assert.deepEqual(componentChanges(head, moved, cwd).backend, ["apps/bta-proxy/app/route.ts"]);
  } finally {
    // mkdtemp creates this exact dedicated test directory; never use a caller-provided delete path.
    assert.equal(cwd.startsWith(join(tmpdir(), "ps-plan-")), true);
    rmSync(cwd, { recursive: true, force: true });
  }
});
