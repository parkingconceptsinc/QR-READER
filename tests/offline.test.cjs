const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const root = resolve(__dirname, '..');
const scope = 'https://example.test/QR-READER/';

async function installedCache({ network = async () => { throw new Error('Network offline'); } } = {}) {
  const events = {};
  const entries = new Map();
  const background = [];
  const cacheKeys = ['unrelated-app', 'lector-qr-old'];
  const url = request => new URL(request.url || request, scope).href;
  const cache = {
    async addAll(requests) {
      for (const request of requests) {
        const path = new URL(url(request)).pathname.slice('/QR-READER/'.length) || 'index.html';
        entries.set(url(request), new Response(readFileSync(resolve(root, path))));
      }
    },
    async match(request) { return entries.get(url(request))?.clone(); },
    async put(request, response) { entries.set(url(request), response); }
  };
  const context = vm.createContext({ URL, Response,
    Request: class extends Request { constructor(path, options) { super(new URL(path, scope), options); } },
    self: { location: { origin: new URL(scope).origin }, registration: { scope },
      addEventListener(type, callback) { events[type] = callback; }, skipWaiting() {}, clients: { claim() {} } },
    caches: { async open(key) { if (!cacheKeys.includes(key)) cacheKeys.push(key); return cache; },
      async keys() { return [...cacheKeys]; },
      async delete(key) { cacheKeys.splice(cacheKeys.indexOf(key), 1); }, match: request => cache.match(request) },
    fetch: network
  });
  vm.runInContext(readFileSync(resolve(root, 'sw.js'), 'utf8'), context);
  for (const type of ['install', 'activate']) {
    let pending; events[type]({ waitUntil(value) { pending = value; } }); await pending;
  }
  return { cacheKeys, cache, caches: context.caches, entries, background,
    async fetch(path, mode = 'cors') {
      let response;
      const request = { url: url(path), method: 'GET', mode };
      events.fetch({ request,
        respondWith(value) { response = value; }, waitUntil(value) { background.push(value); } });
      return response ?? network(request);
    }
  };
}

test('installed PWA loads its document, scripts, decoder worker and worker dependency offline', async () => {
  const installed = await installedCache();
  const html = await (await installed.fetch('./', 'navigate')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.ok((await (await installed.fetch(script)).text()).length > 100);
  const app = await (await installed.fetch(scripts.find(script => script.includes('scanner.js')))).text();
  const workerPath = app.match(/new Worker\('([^']+)'\)/)[1];
  const worker = await (await installed.fetch(workerPath)).text();
  const dependency = worker.match(/importScripts\('([^']+)'\)/)[1];
  assert.ok((await (await installed.fetch(dependency)).text()).length > 10000);
});

test('activation removes obsolete QR caches and preserves unrelated apps', async () => {
  const installed = await installedCache();
  assert.ok(installed.cacheKeys.includes('unrelated-app'));
  assert.ok(!installed.cacheKeys.includes('lector-qr-old'));
  assert.equal(installed.cacheKeys.filter(key => key.startsWith('lector-qr-')).length, 1);
});

test('installed launch serves the cached scanner even when the network never responds', { timeout: 1000 }, async () => {
  const installed = await installedCache({ network: () => new Promise(() => {}) });
  const html = await (await installed.fetch('./', 'navigate')).text();
  assert.match(html, /PCI QR · v37/);
});

test('a same-scope QR destination gets its own document and scanner launch queries still work offline', async () => {
  const h = await installedCache({ network: async request => {
    if (request.url.endsWith('/destination.html')) return new Response('QR destination');
    throw new Error('Offline');
  } });
  assert.equal(await (await h.fetch('./destination.html', 'navigate')).text(), 'QR destination');
  assert.match(await (await h.fetch('./?from=launcher', 'navigate')).text(), /PCI QR · v37/);
  assert.match(await (await h.fetch('./index.html?from=launcher', 'navigate')).text(), /PCI QR · v37/);
});

test('background shell refresh cannot strand offline users on uncached future scripts', async () => {
  const installed = await installedCache({ network: async () => new Response('<script src="./app.js?v=38"></script><script src="./scanner.js?v=38"></script>') });
  await installed.fetch('./', 'navigate');
  await Promise.all(installed.background);
  const html = await (await installed.fetch('./', 'navigate')).text();
  assert.match(html, /PCI QR · v37/);
  assert.ok((await (await installed.fetch('./scanner.js?v=37')).text()).length > 100);
});

for (const method of ['open', 'match']) test(`failed cache ${method} falls back to one network request for HTML, scripts and assets`, async () => {
  const calls = [];
  const h = await installedCache({ network: async request => {
    calls.push(request.url);
    return new Response('Network copy of ' + request.url);
  } });
  const target = method === 'open' ? h.caches : h.cache;
  target[method] = async () => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); };
  for (const path of ['./', './scanner.js?v=37', './vendor/jsQR.js', './icons/pci-qr-192-v7.png']) {
    const response = await h.fetch(path, path === './' ? 'navigate' : 'cors');
    assert.equal(await response.text(), 'Network copy of ' + new URL(path, scope).href);
  }
  await Promise.all(h.background);
  assert.equal(calls.length, 4);
});

test('a cache write failure leaves the online document readable when no cached page exists', async () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  let writes = 0, requests = 0;
  const h = await installedCache({ network: async () => { requests++; return new Response(html); } });
  h.entries.clear();
  h.cache.put = async () => { writes++; throw new DOMException('Full', 'QuotaExceededError'); };
  const response = await h.fetch('./', 'navigate');
  assert.equal(await response.text(), html);
  await Promise.all(h.background);
  assert.ok(writes > 0);
  assert.equal(requests, 1);
});

