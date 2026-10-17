import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNext } from "./api.ts";

test("only paths on this site are followed after signing in", () => {
  for (const ok of ["/", "/settings", "/authorize?client_id=x&state=a%2Fb", "/join/abc"]) assert.equal(safeNext(ok), ok);
  for (const bad of [null, "", "settings", "//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", " /x"]) {
    assert.equal(safeNext(bad), "/", String(bad));
  }
});
