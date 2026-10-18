const CACHE = 'lector-qr-v18';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './app.js?v=15', './vendor/jsQR.js', './vendor/LICENSE-jsQR.txt', './manifest.webmanifest', './icons/pci-qr-192-v6.png', './icons/pci-qr-512-v6.png', './icons/pci-qr-180-v6.png', './icons/pci-qr-maskable-v6.png', './icons/pci-logo.png', './icons/pci-logo-optimized.webp'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
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
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
        return response;
      } catch {
        const indexUrl = new URL('./index.html', self.registration.scope).href;
        const rootUrl = new URL('./', self.registration.scope).href;
        return (await cache.match(indexUrl)) || (await cache.match(rootUrl)) || Response.error();
      }
    })());
    return;
  }

  // The script URL is versioned in index.html and precached with the worker.
  if (new URL(event.request.url).pathname.endsWith('/app.js')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const versionedUrl = new URL('./app.js?v=15', self.registration.scope).href;
      const versioned = await cache.match(versionedUrl);
      if (versioned) return versioned;
      try {
        const response = await fetch(event.request);
        if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
        return response;
      } catch {
        const unversionedUrl = new URL('./app.js', self.registration.scope).href;
        return (await cache.match(unversionedUrl)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
