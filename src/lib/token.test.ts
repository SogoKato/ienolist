import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase64Url, randomToken, safeEqual, sha256, toBase64Url } from "./token.ts";

test("base64url round-trips every byte value without padding", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const length of [0, 1, 2, 3, 4, 5, 255, 256]) {
    const encoded = toBase64Url(bytes.slice(0, length));
    assert.match(encoded, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(fromBase64Url(encoded), bytes.slice(0, length));
  }
});

test("random tokens are url-safe, the requested size, and do not repeat", () => {
  assert.equal(randomToken().length, 43);
  assert.equal(randomToken(16).length, 22);
  assert.match(randomToken(), /^[A-Za-z0-9_-]+$/);
  assert.equal(new Set(Array.from({ length: 1000 }, () => randomToken())).size, 1000);
});

test("sha256 matches a known digest", async () => {
  // sha256("abc"), base64url
  assert.equal(await sha256("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});

test("safeEqual compares whole values", async () => {
  assert.equal(await safeEqual("secret", "secret"), true);
  assert.equal(await safeEqual("secret", "secreT"), false);
  assert.equal(await safeEqual("secret", "secret2"), false);
  assert.equal(await safeEqual("", ""), true);
});
