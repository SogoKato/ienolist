import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod/mini";
import { createMcpHandler } from "./protocol.ts";
import { defineTool, serializeTools, formatIssues } from "./registry.ts";

// Response.json() is typed unknown; the tests inspect arbitrary JSON-RPC payloads.
declare global {
  interface Response {
    json(): Promise<any>;
  }
}

// The protocol layer knows nothing about items: these tests drive it with small tools of their own.
class Visible extends Error {}
const echo = defineTool<{ calls: string[] }, any>({
  name: "echo",
  description: "Echo the text back.",
  scope: "read",
  annotations: { readOnlyHint: true },
  input: z.object({ text: z.string(), times: z.optional(z.int()) }),
  async handler(args, ctx) {
    ctx.calls.push(args.text);
    return { content: [{ type: "text", text: args.text.repeat(args.times ?? 1) }] };
  },
});
const boom = defineTool<{ calls: string[] }, any>({
  name: "boom",
  description: "Always fails.",
  scope: "write",
  annotations: {},
  input: z.object({ visible: z.boolean() }),
  async handler(args) {
    throw args.visible ? new Visible("you can fix this") : new Error("secret internals");
  },
});
const tools = [echo, boom];
const handle = createMcpHandler({
  serverInfo: { name: "t", version: "1" },
  tools,
  toolsJson: serializeTools(tools as never),
  userFacingError: (e) => (e instanceof Visible ? e.message : null),
});

const V = "2026-07-28";
const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": V } };
const send = (body: unknown, headers: Record<string, string> = {}, scopes: string[] = ["read", "write"]) => {
  const ctx = { calls: [] as string[] };
  const request = new Request("https://app.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return handle(request, ctx, scopes).then((response) => ({ response, ctx }));
};
const modern = (id: unknown, method: string, params: object = {}, extra: Record<string, string> = {}) =>
  send({ jsonrpc: "2.0", id, method, params: { ...params, ...meta } }, { "mcp-protocol-version": V, "mcp-method": method, ...extra });

test("ids of any JSON type are echoed back, including in the pre-serialized tools/list", async () => {
  for (const id of [7, "abc", "with \"quotes\" and \\ slashes", null]) {
    const list = (await (await modern(id, "tools/list")).response.json());
    assert.deepEqual(list.id, id);
    assert.equal(list.result.tools.length, 2);
    const ping = (await (await modern(id, "ping")).response.json());
    assert.deepEqual(ping.id, id);
  }
});

test("ping works in both eras", async () => {
  assert.deepEqual((await (await send({ jsonrpc: "2.0", id: 1, method: "ping" })).response.json()).result, {});
  assert.deepEqual((await (await modern(1, "ping")).response.json()).result, { resultType: "complete" });
});

test("a base64-encoded Mcp-Name header is decoded before it is compared", async () => {
  const encoded = `=?base64?${Buffer.from("echo").toString("base64")}?=`;
  const ok = await modern(1, "tools/call", { name: "echo", arguments: { text: "hi" } }, { "mcp-name": encoded });
  assert.equal((await ok.response.json()).result.content[0].text, "hi");
  const wrong = await modern(1, "tools/call", { name: "echo", arguments: { text: "hi" } }, { "mcp-name": `=?base64?${Buffer.from("boom").toString("base64")}?=` });
  assert.equal(wrong.response.status, 400);
  assert.equal((await wrong.response.json()).error.code, -32020);
});

test("requests that are not a single JSON-RPC message are rejected with 400", async () => {
  for (const body of ["null", "42", '"text"', "[]", "[{}]", "{}", '{"jsonrpc":"2.0","id":1}', '{"jsonrpc":"2.0","id":1,"method":5}', "{"]) {
    const { response } = await send(body);
    assert.equal(response.status, 400, body);
    assert.equal(typeof (await response.json()).error.code, "number", body);
  }
});

test("only POST is accepted", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handle(new Request("https://app.test/mcp", { method }), { calls: [] }, []);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

test("notifications and requests without an id get 202 and run nothing", async () => {
  assert.equal((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).response.status, 202);
  const { response, ctx } = await send({ jsonrpc: "2.0", method: "tools/call", params: { name: "echo", arguments: { text: "x" } } });
  assert.equal(response.status, 202);
  assert.deepEqual(ctx.calls, []);
});

test("tool calls validate arguments and list every problem", async () => {
  const call = async (args: unknown) => {
    const { response, ctx } = await modern(1, "tools/call", { name: "echo", arguments: args }, { "mcp-name": "echo" });
    return { result: (await response.json()).result, ctx };
  };
  const missing = await call({});
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /^Invalid arguments: text: /);
  const two = await call({ text: 5, times: 1.5 });
  assert.match(two.result.content[0].text, /text: .*; times: /);
  assert.deepEqual(missing.ctx.calls, []);
  assert.equal((await call({ text: "ab", times: 2 })).result.content[0].text, "abab");
  const none = await modern(1, "tools/call", { name: "boom" }, { "mcp-name": "boom" });
  assert.match((await none.response.json()).result.content[0].text, /^Invalid arguments: visible: /);
});

test("a call without a tool name is a protocol error", async () => {
  const { response } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
  assert.equal((await response.json()).error.code, -32602);
  const missingParams = await send({ jsonrpc: "2.0", id: 1, method: "tools/call" });
  assert.equal((await missingParams.response.json()).error.code, -32602);
});

test("only deliberate errors reach the model; everything else is logged and hidden", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  // console.error is the one process-wide side channel; capture it to assert on the log without noise.
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const visible = (await (await modern(1, "tools/call", { name: "boom", arguments: { visible: true } }, { "mcp-name": "boom" })).response.json()).result;
    assert.deepEqual([visible.isError, visible.content[0].text], [true, "you can fix this"]);
    assert.equal(logged.length, 0);
    const hidden = (await (await modern(1, "tools/call", { name: "boom", arguments: { visible: false } }, { "mcp-name": "boom" })).response.json()).result;
    assert.deepEqual([hidden.isError, hidden.content[0].text], [true, "Internal error"]);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "tool failed");
    assert.equal(logged[0][1], "boom");
  } finally {
    console.error = original;
  }
});

test("each tool needs its own scope", async () => {
  const call = async (name: string, scopes: string[]) => {
    const args = name === "echo" ? { text: "x" } : { visible: true };
    return (await (await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, {}, scopes)).response.json()).result;
  };
  assert.equal((await call("echo", ["read"])).isError, undefined);
  assert.equal((await call("echo", ["write"])).content[0].text, "Missing scope: read");
  assert.equal((await call("boom", ["read"])).content[0].text, "Missing scope: write");
  assert.equal((await call("boom", [])).content[0].text, "Missing scope: write");
  // A tool the caller may not use is refused before its arguments are even looked at.
  const refused = (await (await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } }, {}, ["read"])).response.json()).result;
  assert.equal(refused.content[0].text, "Missing scope: write");
});

test("tool results use resultType only in the modern era", async () => {
  const args = { name: "echo", arguments: { text: "x" } };
  const old = (await (await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: args })).response.json()).result;
  assert.equal(old.resultType, undefined);
  const now = (await (await modern(1, "tools/call", args, { "mcp-name": "echo" })).response.json()).result;
  assert.equal(now.resultType, "complete");
});

test("formatIssues names the path of nested problems", () => {
  const schema = z.object({ a: z.object({ b: z.array(z.string()) }) });
  const parsed = schema.safeParse({ a: { b: ["ok", 3] } });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(formatIssues(parsed.error), /^a\.b\.1: /);
  const root = z.string().safeParse(1);
  if (!root.success) assert.match(formatIssues(root.error), /^\(root\): /);
});
