import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonText, verify } from "./verify-source.mjs";

test("Shopify generated JSON comments are accepted", () => {
  assert.deepEqual(JSON.parse(jsonText('/* Generated theme */\n{"ok":true}')), { ok: true });
});
test("A malformed template is not silently accepted", () => {
  assert.throws(() => JSON.parse(jsonText("/* Generated */ {broken}")));
});
test("Private filenames cannot enter a release", () => {
  assert.throws(() => verify(["../.env"]), /Unsafe path/);
});
