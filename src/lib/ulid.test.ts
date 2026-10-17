import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "./ulid.ts";

test("is 26 Crockford base32 characters", () => {
  assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("encodes the timestamp in the first 10 characters", () => {
  assert.equal(ulid(0).slice(0, 10), "0000000000");
  assert.equal(ulid(1).slice(0, 10), "0000000001");
  assert.equal(ulid(32).slice(0, 10), "0000000010");
  // 2^48 - 1 is the largest representable time.
  assert.equal(ulid(2 ** 48 - 1).slice(0, 10), "7ZZZZZZZZZ");
});

test("sorts by creation time across milliseconds", () => {
  const times = [3, 1, 2, 1_700_000_000_000, 1_600_000_000_000];
  const ids = times.map((t) => ulid(t));
  const expected = [...times].sort((x, y) => x - y).map((t) => ids[times.indexOf(t)]);
  assert.deepEqual([...ids].sort(), expected);
});

test("does not repeat", () => {
  const ids = new Set(Array.from({ length: 10_000 }, () => ulid(1)));
  assert.equal(ids.size, 10_000);
});
