const CACHE = 'lector-qr-v36';
const ASSETS = ['./', './index.html', './styles.css?v=36', './app.js?v=36', './camera.js?v=36', './scanner.js?v=36', './scan-worker.js?v=36', './vendor/jsQR.js', './vendor/LICENSE-jsQR.txt', './manifest.webmanifest?v=36', './icons/pci-qr-48-v7.png', './icons/pci-qr-96-v7.png', './icons/pci-qr-192-v7.png', './icons/pci-qr-512-v7.png', './icons/pci-qr-180-v7.png', './icons/pci-qr-maskable-v7.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lector-qr-') && key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  // Installed launches never wait for a slow network. Refresh the shell in
  // the background; explicit versioned dependencies prevent mixed script loads.
  if (event.request.mode === 'navigate') {
    const cacheReady = caches.open(CACHE);
    const fresh = fetch(event.request, { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('Navigation request failed.');
      const html = await response.clone().text();
      // A newer document must be installed with its own offline dependencies.
      // Keep this version usable if connectivity drops during an update.
      if (!html.includes('./app.js?v=36') || !html.includes('./scanner.js?v=36')) return response;
      const cache = await cacheReady;
      await Promise.all([
        cache.put(event.request, response.clone()),
        cache.put(new URL('./index.html', self.registration.scope).href, response.clone()),
        cache.put(new URL('./', self.registration.scope).href, response.clone())
      ]);
      return response;
    });
    event.waitUntil(fresh.catch(() => {}));
    event.respondWith((async () => {
      const cache = await cacheReady;
      const cached = (await cache.match(event.request)) ||
        (await cache.match(new URL('./index.html', self.registration.scope).href));
      if (cached) return cached;
      return fresh.catch(() => Response.error());
    })());
    return;
  }

  // Match versioned scripts exactly. Substituting a different app version can
  // combine an old document with new dependencies during a worker update.
  if (/\/(app|camera|scanner|scan-worker)\.js$/.test(new URL(event.request.url).pathname)) {
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


