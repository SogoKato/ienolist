import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isApiPath, staticApp } from "./static.ts";

const dir = mkdtempSync(join(tmpdir(), "household-web-"));
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
writeFileSync(join(dir, "sw.js"), "// worker");
writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
const app = staticApp(dir);
after(() => rmSync(dir, { recursive: true, force: true }));

const get = (path: string) => app.request(`http://localhost${path}`);

test("files are served as they are, with caching that fits each kind", async () => {
  const asset = await get("/assets/app-abc123.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log(1)");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const worker = await get("/sw.js");
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get("cache-control"), "no-cache");
});

test("any other page is the app's entry page, so its own routes work when opened directly", async () => {
  for (const path of ["/", "/settings", "/join/abc", "/authorize?client_id=x"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<title>app<\/title>/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  }
});

test("a missing built file is a 404, not the entry page", async () => {
  assert.equal((await get("/assets/missing.js")).status, 404);
});

test("pages carry the same protections as the API", async () => {
  const res = await get("/");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'.*frame-ancestors 'none'/);
});

test("the files outside the web root cannot be reached", async () => {
  for (const path of ["/../package.json", "/%2e%2e/package.json", "/assets/../../package.json"]) {
    const res = await get(path);
    assert.doesNotMatch(await res.text(), /"name": "ienolist"/, path);
  }
});

test("API paths are told apart from the web app's pages", () => {
  for (const path of ["/api/me", "/oauth/token", "/oauth/authorize", "/mcp", "/mcp/", "/.well-known/oauth-authorization-server"]) assert.equal(isApiPath(path), true, path);
  for (const path of ["/", "/settings", "/authorize", "/join/abc", "/mcpx", "/apiary", "/assets/app.js"]) assert.equal(isApiPath(path), false, path);
});
