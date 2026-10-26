import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTags } from "./tags.ts";

test("tags split on spaces and commas, drop a leading # and repeats", () => {
  assert.deepEqual(parseTags(" 主菜　時短,作り置き、#冬 主菜 "), ["主菜", "時短", "作り置き", "冬"]);
  assert.deepEqual(parseTags("  "), []);
});
