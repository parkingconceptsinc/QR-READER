const CACHE = 'lector-qr-v15';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './app.js?v=14', './vendor/jsQR.js', './vendor/LICENSE-jsQR.txt', './manifest.webmanifest', './icons/pci-qr-192-v6.png', './icons/pci-qr-512-v6.png', './icons/pci-qr-180-v6.png', './icons/pci-qr-maskable-v6.png', './icons/pci-logo.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lector-qr-') && key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  // Keep navigations fresh so installed PWAs do not stay trapped on a broken old shell.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
        }
        return response;
      }).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        const indexUrl = new URL('./index.html', self.registration.scope).href;
        const rootUrl = new URL('./', self.registration.scope).href;
        return (await caches.match(indexUrl)) || (await caches.match(rootUrl));
      })
    );
    return;
  }

  // The QR scanner is versioned and fetched network-first to defeat stale JS caches.
  if (new URL(event.request.url).pathname.endsWith('/app.js')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
        }
        return response;
      }).catch(() => caches.match(event.request).then(cached => cached || caches.match(new URL('./app.js', self.registration.scope).href)))
    );
    return;
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
