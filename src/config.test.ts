import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "./config.ts";

test("a public https origin gives the relying party and secure cookies", () => {
  const config = loadConfig({ PUBLIC_URL: "https://lists.example.com" });
  assert.deepEqual(config.rp, { id: "lists.example.com", name: "おかって", origin: "https://lists.example.com" });
  assert.equal(config.origin, "https://lists.example.com");
  assert.equal(config.secureCookies, true);
  assert.equal(config.setupToken, undefined);
});

test("a trailing slash is fine, a port is kept, and the name and setup token are read", () => {
  const config = loadConfig({ PUBLIC_URL: " https://lists.example.com:8443/ ", APP_NAME: " Our fridge ", SETUP_TOKEN: " s3cret " });
  assert.equal(config.origin, "https://lists.example.com:8443");
  assert.equal(config.rp.id, "lists.example.com");
  assert.equal(config.rp.name, "Our fridge");
  assert.equal(config.setupToken, "s3cret");
});

test("an empty setup token means none", () => {
  assert.equal(loadConfig({ PUBLIC_URL: "https://a.example", SETUP_TOKEN: "  " }).setupToken, undefined);
});

test("plain http is allowed for localhost only, without secure cookies", () => {
  for (const host of ["localhost:8787", "127.0.0.1:3000", "[::1]:3000"]) {
    const config = loadConfig({ PUBLIC_URL: `http://${host}` });
    assert.equal(config.secureCookies, false, host);
  }
  assert.throws(() => loadConfig({ PUBLIC_URL: "http://lists.example.com" }), /must be https/);
});

test("a missing or malformed PUBLIC_URL is a clear error", () => {
  for (const [value, message] of [
    [undefined, /PUBLIC_URL is required/],
    ["", /PUBLIC_URL is required/],
    ["lists.example.com", /not a valid URL/],
    ["https://example.com/app", /just an origin/],
    ["https://example.com/?x=1", /just an origin/],
    ["https://user:pw@example.com", /just an origin/],
    ["ftp://example.com", /must be https/],
  ] as const) {
    assert.throws(() => loadConfig({ PUBLIC_URL: value }), (e: unknown) => e instanceof ConfigError && message.test(e.message), String(value));
  }
});

test("pre-registered OAuth clients are read from JSON", () => {
  const clients = [{ clientId: "my-app", name: "My app", redirectUris: ["https://app.example/cb"] }];
  assert.deepEqual(loadConfig({ PUBLIC_URL: "https://a.example", OAUTH_CLIENTS: JSON.stringify(clients) }).oauthClients, clients);
  assert.deepEqual(loadConfig({ PUBLIC_URL: "https://a.example" }).oauthClients, []);
  assert.deepEqual(loadConfig({ PUBLIC_URL: "https://a.example", OAUTH_CLIENTS: "  " }).oauthClients, []);
});

test("malformed OAuth client settings are a clear error", () => {
  for (const [value, message] of [
    ["{", /not valid JSON/],
    ["{}", /must be a JSON array/],
    ['[{"clientId":"a","name":"A"}]', /must be a JSON array/],
    ['[{"clientId":"a","name":"A","redirectUris":[]}]', /must be a JSON array/],
    ['[{"clientId":"a","name":"A","redirectUris":["nope"]}]', /must be a JSON array/],
  ] as const) {
    assert.throws(() => loadConfig({ PUBLIC_URL: "https://a.example", OAUTH_CLIENTS: value }), message, value);
  }
});
