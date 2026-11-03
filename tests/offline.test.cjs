const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const root = resolve(__dirname, '..');
const scope = 'https://example.test/QR-READER/';

async function installedCache() {
  const events = {};
  const entries = new Map();
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
    fetch: async () => { throw new Error('Network offline'); }
  });
  vm.runInContext(readFileSync(resolve(root, 'sw.js'), 'utf8'), context);
  for (const type of ['install', 'activate']) {
    let pending; events[type]({ waitUntil(value) { pending = value; } }); await pending;
  }
  return { cacheKeys,
    async fetch(path, mode = 'cors') {
      let response;
      events.fetch({ request: { url: url(path), method: 'GET', mode },
        respondWith(value) { response = value; }, waitUntil() {} });
      return response;
    }
  };
}

test('installed PWA loads its document, scripts, decoder worker and worker dependency offline', async () => {
  const installed = await installedCache();
  const html = await (await installed.fetch('./', 'navigate')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.ok((await (await installed.fetch(script)).text()).length > 100);
  const app = await (await installed.fetch(scripts.find(script => script.includes('app.js')))).text();
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
