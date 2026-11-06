// Service worker: app-shell offline + pushmeldingen.
const CACHE = 'thuis-shell-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'rota.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Eigen bestanden: netwerk eerst (altijd de nieuwste versie), cache als je offline bent.
// Andere domeinen (Supabase, CDN) gaan direct naar het netwerk.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./')))
  );
});

self.addEventListener('push', (e) => {
  let d = { title: 'Thuis', body: '' };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: d.tag || 'thuis', data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((w) => w.url.startsWith(self.registration.scope));
    // Open app: focussen en via de hash naar het juiste tabblad (app.js luistert op hashchange).
    return c ? c.focus().then((w) => w.navigate(target)).catch(() => {}) : self.clients.openWindow(target);
  }));
});
