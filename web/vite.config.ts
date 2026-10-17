import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: `pnpm start` serves the API on :8787 with PUBLIC_URL=http://localhost:5173 and `pnpm dev:web`
// serves the app on :5173 (passkeys are bound to the origin the browser sees), proxying the rest.
const api = process.env.API_URL ?? "http://localhost:8787";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/oauth", "/mcp", "/.well-known"].map((path) => [path, { target: api }])),
  },
});
