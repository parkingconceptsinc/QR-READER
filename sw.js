const CACHE = 'lector-qr-v38';
const ASSETS = ['./', './index.html', './styles.css?v=38', './app.js?v=38', './camera.js?v=38', './scanner.js?v=38', './scan-worker.js?v=38', './vendor/jsQR.js', './vendor/LICENSE-jsQR.txt', './manifest.webmanifest?v=38', './icons/pci-qr-48-v7.png', './icons/pci-qr-96-v7.png', './icons/pci-qr-192-v7.png', './icons/pci-qr-512-v7.png', './icons/pci-qr-180-v7.png', './icons/pci-qr-maskable-v7.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  const cleanup = async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('lector-qr-') && key !== CACHE).map(key => caches.delete(key)));
  };
  event.waitUntil(Promise.all([cleanup().catch(() => {}), self.clients.claim()]));
});

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; }
}

async function readCached(cacheReady, request, fallback) {
  const cache = await cacheReady;
  if (!cache) return;
  try {
    const hit = await cache.match(request);
    return hit || (fallback && await cache.match(fallback));
  } catch { return undefined; }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Installed launches never wait for a slow network. Refresh the shell in
  // the background; explicit versioned dependencies prevent mixed script loads.
  if (request.mode === 'navigate') {
    const index = new URL('./index.html', self.registration.scope).href;
    const root = new URL('./', self.registration.scope).href;
    // A QR may link to another document in this same scope. Only the two
    // scanner entry points should ever be answered with the offline shell.
    const documentPath = url.origin + url.pathname;
    if (documentPath !== root && documentPath !== index) return;
    const cacheReady = openCache();
    const fresh = fetch(request, { cache: 'no-store' });
    event.waitUntil(fresh.then(async response => {
      if (!response.ok) return;
      const copy = response.clone();
      const cache = await cacheReady;
      if (!cache) return;
      const html = await copy.clone().text();
      // A newer document must be installed with its own offline dependencies.
      // Keep this version usable if connectivity drops during an update.
      if (!html.includes('./app.js?v=38') || !html.includes('./scanner.js?v=38')) return;
      await Promise.all([
        cache.put(request, copy.clone()), cache.put(index, copy.clone()),
        cache.put(root, copy)
      ]);
    }).catch(() => {}));
    event.respondWith(readCached(cacheReady, request, index).then(hit => hit || fresh).catch(() => Response.error()));
    return;
  }

  // Match versioned scripts exactly. Substituting a different app version can
  // combine an old document with new dependencies during a worker update.
  const script = /\/(app|camera|scanner|scan-worker)\.js$/.test(url.pathname);
  event.respondWith(readCached(openCache(), request).then(hit => hit || fetch(request, script ? { cache: 'no-cache' } : undefined)));
});


