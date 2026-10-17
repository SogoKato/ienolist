import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeTools } from "./registry.ts";
import { TOOLS_JSON } from "./tools.generated.ts";
import { tools } from "./tools.ts";

test("tools.generated.ts is up to date (run pnpm gen after changing a tool)", () => {
  assert.equal(TOOLS_JSON, serializeTools(tools as never));
});
