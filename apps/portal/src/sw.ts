// SPDX-License-Identifier: Elastic-2.0
//
// Client-portal service worker (installable PWA). Built by vite-plugin-pwa in
// injectManifest mode, which replaces self.__WB_MANIFEST with the precache
// list of hashed build assets.
//
// SAFETY: this worker NEVER caches /api/* responses. Those carry PII/financial
// data and have server-side side effects (read receipts, access logs, rate
// limits, auth/session checks). Only hash-named static assets + the app shell
// are cached; every API request goes straight to the network.

/// <reference lib="webworker" />

// Augment the worker global with the precache manifest vite-plugin-pwa injects
// in place of `self.__WB_MANIFEST` at build time (workbox searches for that
// exact literal, so it must appear verbatim below).
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- global augmentation
interface WorkerGlobalScope {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
}

// `self` is typed as WorkerGlobalScope by the WebWorker lib; alias to the
// service-worker scope for correctly-typed events without redeclaring `self`.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = 'portal-shell-v1';
const SHELL = 'index.html';
const PRECACHE = self.__WB_MANIFEST.map((e) => e.url);

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.length ? PRECACHE : [SHELL]))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  // Never intercept the API — auth/PII/side-effects must hit the network.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network-first, fall back to the cached app shell offline so
  // the SPA can boot (it then calls /api/portal/auth/me, which fails offline
  // and routes the user to login / an offline notice).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(
        () =>
          caches.match(SHELL).then((r) => r ?? caches.match('/')) as Promise<Response | undefined>,
      ) as Promise<Response>,
    );
    return;
  }

  // Static assets: cache-first (Vite hash-names them, so this is safe).
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          if (res.ok && url.pathname.startsWith('/assets/')) {
            const clone = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        }),
    ),
  );
});

// ---- Web Push ----

interface PushPayload {
  title: string;
  body: string;
  url: string;
}

sw.addEventListener('push', (event) => {
  let data: PushPayload = { title: 'Update from your firm', body: '', url: '/' };
  try {
    if (event.data) data = { ...data, ...(event.data.json() as Partial<PushPayload>) };
  } catch {
    /* keep defaults */
  }
  event.waitUntil(
    sw.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
    }),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          void (client as WindowClient).navigate(target);
          return (client as WindowClient).focus();
        }
      }
      return sw.clients.openWindow(target);
    }),
  );
});
