import { defineConfig } from "@playwright/test";

// A real browser against the built app and the Node entry point, on a throwaway database.
// Passkeys are Chrome's virtual authenticator, so the real WebAuthn code paths run end to end.
const port = 18787;
const base = `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: { baseURL: base, trace: "retain-on-failure" },
  webServer: {
    command: "pnpm build && rm -rf .e2e-data && node src/node.ts",
    url: `${base}/api/setup`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PUBLIC_URL: base, PORT: String(port), DATABASE_PATH: ".e2e-data/app.db" },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
