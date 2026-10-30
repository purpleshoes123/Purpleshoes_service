import { test } from "node:test";
import assert from "node:assert/strict";
import { valkeyUrlWithSecret, resolveManagedValkey } from "./managed-valkey.mjs";

const endpoint = "rediss://master.fixture.apn2.cache.amazonaws.com:6379/0";
const token = "fixture-secret@:/%?#";
const payload = JSON.stringify({ authToken: token });

test("encodes token exactly once without changing endpoint or database", () => {
  const url = new URL(valkeyUrlWithSecret(endpoint, payload));
  assert.equal(decodeURIComponent(url.password), token);
  assert.equal(url.hostname, new URL(endpoint).hostname);
  assert.equal(url.port, "6379");
  assert.equal(url.pathname, "/0");
});

for (const invalid of [
  "redis://master.fixture.cache.amazonaws.com",
  "rediss://localhost",
  "rediss://fixture.cache.amazonaws.com.evil.test",
  endpoint + "?tls=false",
  endpoint + "#fragment",
  endpoint.replace("6379", "6380"),
  endpoint.replace("/0", "/1"),
  endpoint.replace("rediss://", "rediss://user:old@"),
]) {
  test(`rejects unsafe endpoint ${invalid}`, () => {
    assert.throws(() => valkeyUrlWithSecret(invalid, payload), /configuration is invalid/);
  });
}

for (const value of [
  "{private-invalid-json",
  "{}",
  "null",
  '{"authToken":""}',
  JSON.stringify({ authToken: token, host: "elsewhere" }),
]) {
  test(`rejects malformed secret case ${["{private-invalid-json", "{}", "null", '{"authToken":""}'].indexOf(value)}`, () => {
    assert.throws(
      () => valkeyUrlWithSecret(endpoint, value),
      (error) => {
        assert.equal(error.message, "Managed Valkey configuration is invalid");
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
  });
}

test("legacy startup does not read or probe secrets", async () => {
  assert.equal(
    await resolveManagedValkey({
      redisUrl: "legacy",
      readSecret: () => assert.fail(),
      probe: () => assert.fail(),
    }),
    "legacy",
  );
});

test("reads and verifies the credential before returning it", async () => {
  let probed = false;
  const url = await resolveManagedValkey({
    redisUrl: endpoint,
    secretId: "fixture-arn",
    readSecret: async (id) => {
      assert.equal(id, "fixture-arn");
      return { SecretString: payload };
    },
    probe: async (value) => {
      assert.equal(decodeURIComponent(new URL(value).password), token);
      probed = true;
    },
  });
  assert.equal(probed, true);
  assert.equal(new URL(url).hostname, new URL(endpoint).hostname);
});

for (const failAt of ["read", "probe"]) {
  test(`fails closed and hides raw ${failAt} errors`, async () => {
    await assert.rejects(
      resolveManagedValkey({
        redisUrl: endpoint,
        secretId: "fixture-arn",
        readSecret: async () => {
          if (failAt === "read") {
            throw new Error(token);
          }
          return { SecretString: payload };
        },
        probe: async () => {
          throw new Error(token);
        },
      }),
      (error) => error.message === "Managed Valkey startup verification failed",
    );
  });
}
