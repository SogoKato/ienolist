import assert from "node:assert/strict";
import { test } from "node:test";
import { monotonicUlid, ulid } from "./ulid.ts";

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

test("monotonic ids keep creation order within a millisecond", () => {
  const next = monotonicUlid(() => 5000);
  const ids = Array.from({ length: 1000 }, next);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, 1000);
  assert.equal(ids[0].slice(0, 10), ulid(5000).slice(0, 10));
});

test("monotonic ids keep increasing when the clock steps back", () => {
  let now = 9000;
  const next = monotonicUlid(() => now);
  const a = next();
  now = 8000;
  const b = next();
  now = 9001;
  const c = next();
  assert.ok(a < b && b < c);
  assert.equal(b.slice(0, 10), a.slice(0, 10));
});

test("monotonic ids carry across the random digits and move to the next millisecond when they run out", () => {
  const allMax = () => new Uint8Array(16).fill(31);
  const next = monotonicUlid(() => 1, () => Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? 31 : 30)));
  const first = next();
  const second = next();
  assert.equal(first.slice(10), "YYYYYYYYYYYYYYYZ");
  assert.equal(second.slice(10), "YYYYYYYYYYYYYYZ0");
  const exhausted = monotonicUlid(() => 1, allMax);
  const last = exhausted();
  const after = exhausted();
  assert.ok(last < after);
  assert.equal(after.slice(0, 10), "0000000002");
});

test("does not repeat", () => {
  const ids = new Set(Array.from({ length: 10_000 }, () => ulid(1)));
  assert.equal(ids.size, 10_000);
});
