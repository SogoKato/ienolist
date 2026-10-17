// Keeps the app's own files so it opens at once and can start offline. Everything the server
// answers dynamically (the API, OAuth, MCP) is never cached: lists must be fresh, and
// sign-in and consent must always reach the server.
const CACHE = "shell-v1";
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
  // Built files have hashed names: once saved they never change.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        }),
    ),
  );
});
