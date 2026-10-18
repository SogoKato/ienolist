import assert from "node:assert/strict";
import { test } from "node:test";
import { localDate, shortDate } from "./dates.ts";

test("localDate is the local calendar day, not the UTC one", () => {
  // 23:30 local time stays on the same day, whatever the machine's zone.
  assert.equal(localDate(new Date(2026, 9, 18, 23, 30)), "2026-10-18");
  assert.equal(localDate(new Date(2026, 0, 5, 0, 10)), "2026-01-05");
});

test("shortDate drops the year only for this year", () => {
  assert.equal(shortDate("2026-10-05", "2026-10-18"), "10/5");
  assert.equal(shortDate("2025-12-31", "2026-10-18"), "2025/12/31");
});
