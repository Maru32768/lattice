// Keeps the page itself available without a connection. The documents are the page's own business
// (client.ts), so that it knows when it is showing an old copy. Only same-origin page files pass here.
const SHELL = "lattice-shell";
const FILES = ["./", "mobile.js", "mobile.css", "manifest.webmanifest", "icon-256.png", "icon-512.png"];
/** On a poor connection the saved copy shows after this, and the fresh one is there next time. */
const WAIT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function pageFile(event) {
  const cache = await caches.open(SHELL);
  const network = fetch(event.request).then(async (response) => {
    if (response.ok) {
      await cache.put(event.request, response.clone());
    }
    return response;
  });
  event.waitUntil(network.catch(() => {}));
  const saved = await cache.match(event.request);
  if (!saved) {
    return network;
  }
  // An error page is no better than no answer: with the PC off, a tunnel answers with one.
  const fresh = network.then(
    (response) => (response.ok ? response : saved),
    () => saved,
  );
  return Promise.race([fresh, new Promise((resolve) => setTimeout(() => resolve(saved), WAIT_MS))]);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "GET" && url.origin === location.origin && !url.pathname.includes("/api/")) {
    event.respondWith(pageFile(event));
  }
});
