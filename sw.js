const CACHE = 'lector-qr-v33';
const ASSETS = ['./', './index.html', './styles.css', './styles.css?v=33', './app.js', './app.js?v=33', './camera.js?v=33', './scan-worker.js?v=33', './vendor/jsQR.js', './vendor/LICENSE-jsQR.txt', './manifest.webmanifest', './icons/pci-qr-192-v6.png', './icons/pci-qr-512-v6.png', './icons/pci-qr-180-v6.png', './icons/pci-qr-maskable-v6.png', './icons/pci-logo.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lector-qr-') && key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  // Serve the installed shell instantly; the versioned worker replaces it on updates.
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        // Refresh the installed shell whenever online so a stale home-screen
        // document cannot outlive the worker update.
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) {
          event.waitUntil(cache.put(event.request, response.clone()));
          return response;
        }
        throw new Error('Navigation request failed.');
      } catch {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const indexUrl = new URL('./index.html', self.registration.scope).href;
        const rootUrl = new URL('./', self.registration.scope).href;
        return (await cache.match(indexUrl)) || (await cache.match(rootUrl)) || Response.error();
      }
    })());
    return;
  }

  // Match versioned scripts exactly. Substituting a different app version can
  // combine an old document with new dependencies during a worker update.
  if (/\/(app|camera|scan-worker)\.js$/.test(new URL(event.request.url).pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      return fetch(event.request, { cache: 'no-cache' });
    })());
    return;
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
