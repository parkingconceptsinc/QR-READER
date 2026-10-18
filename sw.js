const CACHE = 'lector-qr-v8';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/pci-qr-192-v6.png', './icons/pci-qr-512-v6.png', './icons/pci-qr-180-v6.png', './icons/pci-qr-maskable-v6.png', './icons/pci-logo.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lector-qr-') && key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.url === 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js') {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok || response.type === 'opaque') {
        const copy = response.clone();
        event.waitUntil(caches.open('pci-qr-decoder-v1').then(cache => cache.put(event.request, copy)));
      }
      return response;
    })));
    return;
  }
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
