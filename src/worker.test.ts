import assert from "node:assert/strict";
import { test } from "node:test";
import { siteFor } from "./worker.ts";

test("with PUBLIC_URL set, every request belongs to that one site", () => {
  assert.deepEqual(siteFor("https://ienolist.example.workers.dev/api/me", "https://lists.example.com"), {});
});

test("without PUBLIC_URL, a site is the origin the request came to", () => {
  assert.deepEqual(siteFor("https://ienolist.example.workers.dev/api/me?x=1", undefined), { origin: "https://ienolist.example.workers.dev" });
  assert.deepEqual(siteFor("https://lists.example.com/mcp", " "), { origin: "https://lists.example.com" });
  assert.deepEqual(siteFor("http://localhost:8787/api/me", undefined), { origin: "http://localhost:8787" });
});

test("without PUBLIC_URL, plain http is sent to https, except on this machine", () => {
  assert.deepEqual(siteFor("http://ienolist.example.workers.dev/oauth/authorize?a=1", undefined), { redirect: "https://ienolist.example.workers.dev/oauth/authorize?a=1" });
});
