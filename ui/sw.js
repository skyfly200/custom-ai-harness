// Service worker for the installed app. It keeps the pages, scripts and icons
// so the app opens when the harness is slow or unreachable, but always asks the
// harness first, so an update to the harness shows up the next time you open
// it. Nothing under /ui/api/ or /v1/ is ever kept, and neither is anything
// that isn't a plain GET: chats, answers and keys are never stored here.
'use strict';

const CACHE = 'bright-chat-v6';

function keepable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  // Only the app's own pages and assets, wherever it is served: /ui/ or the site root
  const base = new URL('./', self.location).pathname;
  if (!url.pathname.startsWith(base)) return false;
  const rel = url.pathname.slice(base.length);
  if (/(^|\/)api\//.test(rel) || /^(v1|openrouter-proxy|auth|login|logout|admin|healthz)(\/|$)/.test(rel)) return false;
  return rel === '' || rel === 'ui/' || /^(index|chat|usage|usage-users|routing|agents|runs|tools|settings|users)$/.test(rel) || /\.(html|js|css|svg|png|webmanifest)$/.test(rel);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Fetched with the page's credentials, so a harness behind HARNESS_PASSWORD still works
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['chat', 'chat.html', 'bright.css', 'style.css', 'chat.css', 'calm.css', 'mobile.css', 'dialogs.js', 'bright.js', 'nav.js', 'nav.css', 'chat.js', 'chatmerge.js', 'modelAlias.js', 'tokens.js', 'costs.js', 'cachetimer.js', 'notify.js', 'dictation.js', 'markdown.js', 'favicon.svg'])).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!keepable(request)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      // Only a good answer is kept: a login prompt or an error page must not replace the app
      if (response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => {});
      return response;
    } catch (err) {
      const kept = await cache.match(request, { ignoreSearch: true });
      if (kept) return kept;
      throw err;
    }
  })());
});

// Tapping a "waiting for you" notification brings the app forward (or opens it)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './chat', self.location).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = all.find((c) => c.url.split('#')[0] === target.split('#')[0]) || all[0];
    if (mine) { await mine.focus(); return; }
    await self.clients.openWindow(target);
  })());
});
