import type { RelyingParty } from "./auth/webauthn.ts";

export type Config = {
  // The app's public origin, e.g. https://lists.example.com. Passkeys, cookies and OAuth URLs are tied to it.
  origin: string;
  rp: RelyingParty;
  // Cookies get the Secure flag and the __Host- prefix on https, i.e. everywhere but local development.
  secureCookies: boolean;
  setupToken?: string;
};

export class ConfigError extends Error {}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

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
    rp: { id: url.hostname, name: env.APP_NAME?.trim() || "Household lists", origin: url.origin },
    secureCookies: url.protocol === "https:",
    setupToken: setupToken ? setupToken : undefined,
  };
}
