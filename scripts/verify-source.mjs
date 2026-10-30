import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
let checked = 0;
for (const [manifestFile, sourceDir] of [
  ["backend-source-manifest.json", "apps/bta-proxy"],
  ["theme-source-manifest.json", "themes/kpurpleshoes-theme"],
]) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "docs/provenance", manifestFile), "utf8"),
  );
  for (const [name, record] of Object.entries(manifest.files)) {
    assert(!path.isAbsolute(name) && !name.split("/").includes(".."), `Unsafe path: ${name}`);
    const bytes = fs.readFileSync(path.join(root, sourceDir, name));
    assert.equal(bytes.length, record.bytes, `Size changed: ${sourceDir}/${name}`);
    assert.equal(sha256(bytes), record.sha256, `Hash changed: ${sourceDir}/${name}`);
    checked++;
  }
}
console.log(
  `Production import verified: ${checked} original source files match their SHA-256 records.`,
);
