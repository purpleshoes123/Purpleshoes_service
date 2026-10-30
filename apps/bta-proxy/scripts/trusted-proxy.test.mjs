import { test } from "node:test";
import assert from "node:assert/strict";
import proxyaddr from "proxy-addr";

test("IPv4-mapped IPv6 prefixes cannot trust arbitrary public clients", () => {
  const trust = proxyaddr.compile("::ffff:10.0.0.0/8");
  assert.equal(trust("198.51.100.7", 0), false);
});
test("Explicit IPv4 trusted networks retain their intended boundary", () => {
  const trust = proxyaddr.compile("10.0.0.0/8");
  assert.equal(trust("10.1.2.3", 0), true);
  assert.equal(trust("198.51.100.7", 0), false);
});
