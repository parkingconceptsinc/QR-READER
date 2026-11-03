const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const flush = () => new Promise(setImmediate);

function element(id) {
  const events = {};
  return { hidden: true, disabled: false, value: '', textContent: '', options: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this[name] = value; },
    append() {}, scrollIntoView() {}, replaceChildren(...items) { this.options = items; },
    add(item) { this.options.push(item); }, addEventListener(type, callback) { events[type] = callback; },
    fire(type, extra = {}) { return events[type]?.({ target: this, ...extra }); },
    getBoundingClientRect: () => id === 'stage' ? { left: 0, top: 0, width: 360, height: 560 }
      : { left: 60, top: 160, width: 240, height: 240 }
  };
}

async function app({ native = true, workerFails = false, workerHangs = false, denied = false } = {}) {
  const elements = new Map();
  const storage = new Map([['pci-qr-camera-v1', 'front']]);
  const frames = [];
  const timers = new Map();
  const windowEvents = {};
  const tracks = [];
  let timerId = 0;
  let time = 1000;
  let nextCodes = [];
  let workerMessage = null;
  let workerInstance = null;
  let mainDecodeCount = 0;
  const devices = [
    { kind: 'videoinput', deviceId: 'front', label: 'Front Camera' },
    { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
    { kind: 'videoinput', deviceId: 'main', label: 'Back Main Camera' }
  ];
  function get(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); }
  const video = get('video');
  video.videoWidth = 3840; video.videoHeight = 2160; video.readyState = 4;
  video.play = async () => {};
  video.requestVideoFrameCallback = callback => frames.push(callback);
  const canvas = () => ({ width: 1, height: 1, getContext: () => ({
    drawImage() {}, getImageData: (x, y, width, height) => ({ width, height,
      data: new Uint8ClampedArray(width * height * 4) })
  }) });
  const mainDecoder = () => { mainDecodeCount++; return nextCodes.length ? { data: nextCodes[0].rawValue } : null; };
  const document = { hidden: false, getElementById: get,
    createElement: tag => tag === 'canvas' ? canvas() : element(tag),
    addEventListener() {}, head: { append(script) { context.jsQR = mainDecoder; queueMicrotask(script.onload); } }
  };
  const context = vm.createContext({ document, DOMException, URL, console,
    navigator: { mediaDevices: {
      getSupportedConstraints: () => ({ pointsOfInterest: true }),
      enumerateDevices: async () => devices,
      getUserMedia: async constraints => {
        if (denied) throw new DOMException('Permission denied', 'NotAllowedError');
        const id = constraints.video?.deviceId?.exact || 'main';
        const settings = { deviceId: id, facingMode: id === 'front' ? 'user' : 'environment',
          width: 3840, height: 2160, zoom: 1 };
        const track = { label: devices.find(device => device.deviceId === id).label, readyState: 'live',
          getSettings: () => settings, getConstraints: () => constraints.video,
          getCapabilities: () => ({ focusMode: ['continuous'], exposureMode: ['continuous'],
            whiteBalanceMode: ['continuous'], width: { max: 3840 }, height: { max: 2160 }, zoom: { min: 1, max: 8, step: 0.1 } }),
          applyConstraints: async constraints => { Object.assign(settings, constraints.advanced?.[0]); },
          stop() { this.readyState = 'ended'; }, addEventListener() {}
        };
        tracks.push(track);
        return { getTracks: () => [track], getVideoTracks: () => [track] };
      }
    }, vibrate() {} },
    localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: () => null, setItem() {} },
    history: { pushState() {} }, location: { href: 'https://example.test/QR-READER/',
      assign(url) { this.href = url; }, reload() {} },
    performance: { now: () => time += 100 }, Date,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: callback => frames.push(callback),
    Option: function(text, value) { this.text = text; this.value = value; },
    isSecureContext: true, addEventListener(type, callback) { windowEvents[type] = callback; },
    Worker: class {
      constructor() { workerInstance = this; }
      terminate() { this.terminated = true; }
      postMessage(message) {
        workerMessage = message;
        if (workerFails) queueMicrotask(() => this.onerror({ preventDefault() {} }));
        else if (!workerHangs) queueMicrotask(() => this.onmessage({ data: { id: message.id, codes: nextCodes } }));
      }
    }
  });
  context.window = context;
  if (native) context.BarcodeDetector = class { async detect() { return nextCodes; } };
  for (const file of ['camera.js', 'app.js']) vm.runInContext(readFileSync(require.resolve('../' + file), 'utf8'), context);
  await flush(); await flush();
  return { get, context, tracks, storage, windowEvents,
    codes(value) { nextCodes = value ? [{ rawValue: value }] : []; },
    async frame() { const callback = frames.shift(); assert.ok(callback, 'a scan frame must be scheduled'); await callback(); await flush(); },
    runTimer(delay) {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, `timer ${delay} must exist`); timers.delete(entry[0]); entry[1].callback();
    },
    resolveWorker() { workerInstance.onmessage({ data: { id: workerMessage.id, codes: nextCodes } }); },
    get mainDecodeCount() { return mainDecodeCount; }
  };
}

test('app starts in rear automatic mode, clears legacy preferences and excludes the front picker option', async () => {
  const h = await app();
  assert.equal(h.tracks.at(-1).label, 'Back Main Camera');
  assert.equal(h.storage.has('pci-qr-camera-v1'), false);
  assert.ok(h.get('cameraSelect').options.every(option => option.value !== 'front'));
  assert.match(h.get('cameraHint').textContent, /3840 × 2160/);
  assert.match(h.get('cameraHint').textContent, /Autofocus/);
  assert.equal(h.get('zoomControls').hidden, false);
  assert.equal(h.get('focusButton').hidden, false);
});

test('manual rear selection is scoped to the current visit and automatic selection resumes on return', async () => {
  const h = await app();
  h.get('cameraSelect').value = 'ultra'; h.get('cameraSelect').fire('change');
  await flush(); await flush();
  assert.equal(h.tracks.at(-1).label, 'Back Ultra Wide Camera');
  h.windowEvents.pagehide();
  h.windowEvents.pageshow(); await flush(); await flush();
  assert.equal(h.tracks.at(-1).label, 'Back Main Camera');
});

test('zoom controls, auto reset and tap focus update the same live camera', async () => {
  const h = await app();
  h.get('zoomRange').value = '2'; await h.get('zoomRange').fire('input'); await flush();
  assert.equal(h.get('zoomValue').textContent, '2.0×');
  assert.equal(h.get('autoZoomButton')['aria-pressed'], 'false');
  h.get('stage').fire('pointerup', { clientX: 180, clientY: 280 }); await flush();
  assert.equal(h.tracks.at(-1).getSettings().pointsOfInterest[0].x, 0.5);
  await h.get('autoZoomButton').fire('click'); await flush();
  assert.equal(h.get('zoomValue').textContent, '1.0×');
  assert.equal(h.get('autoZoomButton')['aria-pressed'], 'true');
  assert.equal(h.tracks.length, 1);
});

for (const native of [true, false]) test(`${native ? 'native' : 'threaded'} scanning opens a URL and rear scanning resumes on return`, async () => {
  const h = await app({ native });
  h.codes('https://example.com/qr-v33');
  await h.frame();
  assert.equal(h.context.location.href, 'https://example.com/qr-v33');
  assert.ok(h.tracks.every(track => track.readyState === 'ended'));
  h.codes(null); h.windowEvents.pageshow(); await flush(); await flush();
  assert.equal(h.tracks.at(-1).readyState, 'live');
  assert.equal(h.tracks.at(-1).getSettings().facingMode, 'environment');
});

test('a worker failure loads the local decoder and continues the same scan', async () => {
  const h = await app({ native: false, workerFails: true });
  h.codes('PCI QR v33'); await h.frame();
  assert.equal(h.get('resultValue').textContent, 'PCI QR v33');
  assert.equal(h.mainDecodeCount, 1);
});

test('a hung worker times out and the local decoder recovers without restarting the camera', async () => {
  const h = await app({ native: false, workerHangs: true });
  h.codes('PCI QR v33');
  const pending = h.frame(); await flush(); h.runTimer(1800); await pending;
  assert.equal(h.get('resultValue').textContent, 'PCI QR v33');
  assert.equal(h.mainDecodeCount, 1);
  assert.equal(h.tracks.length, 1);
});

test('permission failure leaves a working retry button and no live camera', async () => {
  const h = await app({ denied: true });
  assert.match(h.get('status').textContent, /permission is blocked/);
  assert.equal(h.get('cameraButton').disabled, false);
  assert.equal(h.tracks.length, 0);
});
