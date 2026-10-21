// Keeps the app's own files so it opens at once and can start offline. Everything the server
// answers dynamically (the API, OAuth, MCP) is never cached: lists must be fresh, and
// sign-in and consent must always reach the server.
// A new name drops what earlier versions saved (shell-v1 could hold a page saved as a script).
const CACHE = "shell-v2";
const NEVER = ["/api/", "/oauth/", "/mcp", "/.well-known/"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || NEVER.some((p) => url.pathname.startsWith(p))) return;

  // Pages: the network first (so a new version shows up), the saved shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }
  // Built files have hashed names: once saved they never change. Only those are kept, and never
  // an HTML answer: Cloudflare answers a missing file with the app's page (status 200), and
  // keeping that under a script's name would leave the app blank on this device for good.
  if (!url.pathname.startsWith("/assets/")) return;
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          const html = (response.headers.get("content-type") ?? "").startsWith("text/html");
          if (response.ok && !html) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        }),
    ),
  );
});
