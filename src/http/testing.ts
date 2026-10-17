import assert from "node:assert/strict";
import { VirtualAuthenticator } from "../auth/virtual-authenticator.ts";

export const ORIGIN = "https://lists.example.com";

type Handle = (url: string, init: RequestInit) => Response | Promise<Response>;

// A browser, as far as the HTTP tests need: it keeps cookies and sends the Origin header.
export class Browser {
  cookies = new Map<string, string>();
  origin: string | null;
  readonly site: string;
  readonly #handle: Handle;

  constructor(handle: Handle, site = ORIGIN) {
    this.#handle = handle;
    this.site = site;
    this.origin = site;
  }

  async fetch(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const sent: Record<string, string> = { ...headers };
    if (this.cookies.size) sent.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.origin && method !== "GET") sent.origin = this.origin;
    if (body !== undefined && !sent["content-type"]) sent["content-type"] = "application/json";
    const res = await this.#handle(`${this.site}${path}`, { method, headers: sent, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...value] = pair.split("=");
      if (/max-age=0/i.test(line) || value.join("=") === "") this.cookies.delete(name);
      else this.cookies.set(name, value.join("="));
    }
    return res;
  }
  get = (path: string) => this.fetch("GET", path);
  post = (path: string, body: unknown = {}) => this.fetch("POST", path, body);
  patch = (path: string, body: unknown) => this.fetch("PATCH", path, body);
  delete = (path: string) => this.fetch("DELETE", path);
}

// The first person sets the app up: a new household, and a browser signed in as its admin.
export async function setUpHousehold(browser: Browser, name = "Aki") {
  const device = await VirtualAuthenticator.create();
  const start = await (await browser.post("/api/setup/options", { displayName: name, householdName: "Home" })).json();
  const res = await browser.post("/api/setup/finish", { challengeId: start.challengeId, response: await device.register(start.options, browser.site), deviceName: "Phone" });
  assert.equal(res.status, 201);
  return { browser, device, me: await res.json() };
}

export async function signIn(browser: Browser, device: VirtualAuthenticator) {
  const start = await (await browser.post("/api/login/options")).json();
  return browser.post("/api/login/finish", { challengeId: start.challengeId, response: await device.authenticate(start.options, browser.site) });
}
