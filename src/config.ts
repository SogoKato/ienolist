import * as z from "zod/mini";
import type { RelyingParty } from "./auth/webauthn.ts";
import type { PreregisteredClient } from "./oauth/service.ts";

export type Config = {
  // The app's public origin, e.g. https://lists.example.com. Passkeys, cookies and OAuth URLs are tied to it.
  origin: string;
  rp: RelyingParty;
  // Cookies get the Secure flag and the __Host- prefix on https, i.e. everywhere but local development.
  secureCookies: boolean;
  setupToken?: string;
  // OAuth clients known in advance, for clients that cannot register themselves.
  oauthClients: PreregisteredClient[];
};

export class ConfigError extends Error {}

export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const clientsSchema = z.array(
  z.object({ clientId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)), redirectUris: z.array(z.url()).check(z.minLength(1)) }),
);

function loadClients(raw: string | undefined): PreregisteredClient[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("OAUTH_CLIENTS is not valid JSON");
  }
  const result = clientsSchema.safeParse(parsed);
  if (!result.success) throw new ConfigError('OAUTH_CLIENTS must be a JSON array of {"clientId", "name", "redirectUris": [...]}');
  return result.data;
}

// Reads the settings from environment variables (or Worker vars and secrets).
export function loadConfig(env: Record<string, string | undefined>): Config {
  const raw = env.PUBLIC_URL?.trim();
  if (!raw) throw new ConfigError("PUBLIC_URL is required, e.g. https://lists.example.com");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_URL is not a valid URL: ${raw}`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError("PUBLIC_URL must be just an origin (no path, query or credentials): the app has to live at the root of its host");
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigError("PUBLIC_URL must be https (http is allowed only for localhost)");
  }
  const setupToken = env.SETUP_TOKEN?.trim();
  return {
    origin: url.origin,
    rp: { id: url.hostname, name: env.APP_NAME?.trim() || "おかって", origin: url.origin },
    secureCookies: url.protocol === "https:",
    setupToken: setupToken ? setupToken : undefined,
    oauthClients: loadClients(env.OAUTH_CLIENTS),
  };
}
