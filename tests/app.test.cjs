const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const flush = () => new Promise(setImmediate);

function element(id) {
  const events = {};
  return { hidden: true, disabled: false, value: '', textContent: '', options: [], style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this[name] = value; },
    append() {}, scrollIntoView() {}, replaceChildren(...items) { this.options = items; },
    add(item) { this.options.push(item); }, addEventListener(type, callback) { events[type] = callback; },
    fire(type, extra = {}) { return events[type]?.({ target: this, ...extra }); },
    getBoundingClientRect: () => id === 'stage' ? { left: 0, top: 0, width: 360, height: 560 }
      : { left: 60, top: 160, width: 240, height: 240 }
  };
}

async function app({ native = true, workerFails = false, workerHangs = false, denied = false,
  historyState = null, setup, scriptLoader, nativeDetect = codes => codes } = {}) {
  const elements = new Map();
  const storage = new Map([['pci-qr-camera-v1', 'front']]);
  const frames = [];
  const timers = new Map();
  const windowEvents = {};
  const documentEvents = {};
  const visits = [];
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
  video.videoWidth = 3840; video.videoHeight = 2160; video.readyState = 4; video.currentTime = 0;
  video.play = async () => {};
  video.requestVideoFrameCallback = callback => { frames.push(callback); return callback; };
  video.cancelVideoFrameCallback = callback => { const i = frames.indexOf(callback); if (i >= 0) frames.splice(i, 1); };
  const canvas = () => ({ width: 1, height: 1, getContext: () => ({
    drawImage() {}, getImageData: (x, y, width, height) => ({ width, height,
      data: new Uint8ClampedArray(width * height * 4) })
  }) });
  const mainDecoder = () => { mainDecodeCount++; return nextCodes.length ? { data: nextCodes[0].rawValue } : null; };
  const document = { hidden: false, getElementById: get,
    createElement: tag => tag === 'canvas' ? canvas() : element(tag),
    addEventListener(type, callback) { documentEvents[type] = callback; },
    head: { append(script) {
      if (scriptLoader) return scriptLoader(script, context, mainDecoder);
      context.jsQR = mainDecoder; queueMicrotask(script.onload);
    } }
  };
  const context = vm.createContext({ document, DOMException, AbortController, URL, console,
    createImageBitmap: async () => ({ width: 200, height: 200, close() {} }),
    navigator: { mediaDevices: {
      getSupportedConstraints: () => ({ pointsOfInterest: true }),
      enumerateDevices: async () => devices,
      getUserMedia: async constraints => {
        if (denied) throw new DOMException('Permission denied', 'NotAllowedError');
        const id = constraints.video?.deviceId?.exact || 'main';
        const settings = { deviceId: id, facingMode: id === 'front' ? 'user' : 'environment',
          width: 3840, height: 2160, zoom: 1 };
        const events = {};
        const track = { label: devices.find(device => device.deviceId === id).label, readyState: 'live',
          getSettings: () => settings, getConstraints: () => constraints.video,
          getCapabilities: () => ({ focusMode: ['continuous'], exposureMode: ['continuous'],
            whiteBalanceMode: ['continuous'], width: { max: 3840 }, height: { max: 2160 }, zoom: { min: 1, max: 8, step: 0.1 } }),
          applyConstraints: async constraints => { Object.assign(settings, ...(constraints.advanced || [])); },
          stop() { this.readyState = 'ended'; },
          addEventListener(type, callback) { events[type] = callback; }, fire(type) { events[type]?.(); }
        };
        tracks.push(track);
        return { getTracks: () => [track], getVideoTracks: () => [track] };
      }
    }, vibrate() {} },
    localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: () => null, setItem() {} },
    history: { state: historyState, replaceState(state) { this.state = state; } },
    location: { href: 'https://example.test/QR-READER/',
      assign(url) { visits.push(url); this.href = url; }, reload() {} },
    performance: { now: () => time }, Date: class extends Date { static now() { return time; } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: callback => { frames.push(callback); return callback; },
    cancelAnimationFrame(callback) { const i = frames.indexOf(callback); if (i >= 0) frames.splice(i, 1); },
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
  setup?.(context);
  if (native) context.BarcodeDetector = class { async detect() { return nativeDetect(nextCodes); } };
  for (const file of ['camera.js', 'scanner.js', 'app.js']) vm.runInContext(readFileSync(require.resolve('../' + file), 'utf8'), context);
  await flush(); await flush();
  return { get, context, tracks, storage, windowEvents, visits,
    visibility(hidden) { document.hidden = hidden; documentEvents.visibilitychange(); },
    advance(ms) { time += ms; },
    get frameCount() { return frames.length; },
    hasTimer(delay) { return [...timers.values()].some(timer => timer.delay === delay); },
    codes(...values) { nextCodes = values.filter(Boolean).map(rawValue => ({ rawValue })); },
    async frame(mediaTime) {
      time += 100;
      video.currentTime = mediaTime ?? time / 1000;
      const callback = frames.shift();
      assert.ok(callback, 'a scan frame must be scheduled');
      await callback(time, { mediaTime: video.currentTime }); await flush();
    },
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

test('consecutive text QR codes retain the same focused camera instead of reopening it', async () => {
  const h = await app();
  h.codes('FIRST TEXT'); await h.frame();
  h.codes('SECOND TEXT'); await h.frame();
  assert.equal(h.get('resultValue').textContent, 'SECOND TEXT');
  assert.equal(h.tracks.length, 1);
  assert.equal(h.tracks[0].readyState, 'live');
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
  assert.equal(h.get('stage')['data-state'], 'error');
  assert.equal(h.get('stage')['aria-busy'], 'false');
});

test('visual state follows manual stop and resume without holding up acquisition', async () => {
  const h = await app();
  assert.equal(h.get('stage')['data-state'], 'scanning');
  assert.equal(h.get('stage')['aria-busy'], 'false');
  h.get('cameraButton').fire('click');
  assert.equal(h.get('stage')['data-state'], 'idle');
  assert.equal(h.tracks[0].readyState, 'ended');
  h.get('cameraButton').fire('click');
  assert.equal(h.get('stage')['data-state'], 'opening');
  assert.equal(h.get('stage')['aria-busy'], 'true');
  await flush(); await flush();
  assert.equal(h.get('stage')['data-state'], 'scanning');
  assert.equal(h.tracks.at(-1).readyState, 'live');
});

test('importing text while manually paused finishes the busy state and keeps the camera stopped', async () => {
  const h = await app();
  h.get('cameraButton').fire('click');
  h.codes('IMPORTED TEXT');
  h.get('fileInput').files = [{}];
  h.get('fileInput').fire('change');
  assert.equal(h.get('stage')['data-state'], 'reading');
  await flush(); await flush();
  assert.equal(h.get('resultValue').textContent, 'IMPORTED TEXT');
  assert.equal(h.get('stage')['data-state'], 'idle');
  assert.equal(h.get('stage')['aria-busy'], 'false');
  assert.equal(h.tracks.length, 1);
  assert.equal(h.tracks[0].readyState, 'ended');
});

test('reduced motion skips the reticle animation while tap focus still reaches the camera', async () => {
  const h = await app();
  h.context.matchMedia = () => ({ matches: true });
  h.get('focusReticle').animate = () => { throw new Error('Reduced motion must not animate'); };
  h.get('stage').fire('pointerup', { clientX: 180, clientY: 280 });
  await flush();
  assert.equal(h.tracks[0].getSettings().pointsOfInterest[0].x, 0.5);
  assert.equal(h.tracks[0].readyState, 'live');
});


const scannerURL = 'https://example.test/QR-READER/';
const firstLink = 'https://example.com/first';
const nextLink = 'https://example.com/next';

for (const native of [true, false]) test(`Back keeps the same ${native ? 'native' : 'worker'} QR in view and opens a different link immediately`, async () => {
  const h = await app({ native, historyState: { other: 'keep' } });
  h.codes(firstLink); await h.frame();
  h.visibility(true); h.windowEvents.pagehide(); h.advance(30000);
  h.context.location.href = scannerURL;
  h.windowEvents.pageshow({ persisted: true });
  h.windowEvents.popstate({ state: h.context.history.state });
  h.visibility(false); await flush();
  const camera = h.tracks.at(-1);
  assert.equal(h.tracks.length, 2);
  assert.equal(h.context.history.state.other, 'keep');
  for (let i = 0; i < 15; i++) await h.frame();
  h.codes(null); await h.frame(); h.advance(60000);
  h.codes(firstLink); await h.frame();
  assert.deepEqual(h.visits, [firstLink]);
  assert.equal(h.get('openLink').href, firstLink);
  assert.equal(camera.readyState, 'live');
  h.codes(nextLink); await h.frame();
  assert.deepEqual(h.visits, [firstLink, nextLink]);
  assert.equal(camera.readyState, 'ended');
});

test('Back into a rebuilt document remembers only the QR opened from that history entry', async () => {
  const before = await app();
  before.codes(firstLink); await before.frame();
  const restored = await app({ historyState: structuredClone(before.context.history.state) });
  restored.codes(firstLink); await restored.frame();
  assert.deepEqual(restored.visits, []);
  assert.equal(restored.get('openLink').hidden, false);
  restored.codes('TEXT'); await restored.frame();
  assert.equal(restored.get('resultValue').textContent, 'TEXT');
  assert.equal(restored.context.history.state.qrReturnValue, '');
  restored.codes(firstLink); await restored.frame();
  assert.deepEqual(restored.visits, [firstLink]);
  const fresh = await app();
  fresh.codes(firstLink); await fresh.frame();
  assert.deepEqual(fresh.visits, [firstLink]);
});

for (const mode of [{}, { native: false }, { native: false, workerFails: true }]) {
  const label = mode.workerFails ? 'local' : mode.native === false ? 'worker' : 'native';
  test(`${label} accepts a second label with the same URL after the view has cleared`, async () => {
    const h = await app(mode);
    h.codes(firstLink); await h.frame();
    h.windowEvents.pagehide(); h.context.location.href = scannerURL;
    h.windowEvents.pageshow({ persisted: true }); await flush();
    for (let i = 0; i < 12; i++) await h.frame();
    assert.deepEqual(h.visits, [firstLink], 'a held label must not send Back into a loop');
    h.codes(null);
    for (let i = 0; i < 18; i++) await h.frame();
    assert.equal(h.context.history.state.qrReturnValue, '');
    h.codes(firstLink); await h.frame();
    assert.deepEqual(h.visits, [firstLink, firstLink]);
  });
}

test('the new URL wins when both labels are reported, without alternating between them after Back', async () => {
  const h = await app({ historyState: { qrReturnValue: firstLink } });
  h.codes(firstLink, nextLink); await h.frame();
  assert.deepEqual(h.visits, [nextLink]);
  const rebuilt = await app({ historyState: structuredClone(h.context.history.state) });
  rebuilt.codes(nextLink, firstLink);
  for (let i = 0; i < 12; i++) await rebuilt.frame();
  assert.deepEqual(rebuilt.visits, []);
  rebuilt.codes(firstLink, nextLink, 'https://example.com/third'); await rebuilt.frame();
  assert.deepEqual(rebuilt.visits, ['https://example.com/third']);
});

test('live text leaves the camera in view and a held first text does not hide or repeatedly save the second', async () => {
  const h = await app();
  let scrolls = 0;
  h.get('result').scrollIntoView = () => scrolls++;
  h.codes('ONE'); await h.frame();
  for (let i = 0; i < 16; i++) await h.frame();
  h.codes('ONE', 'TWO'); await h.frame();
  assert.equal(h.get('resultValue').textContent, 'TWO');
  h.codes('TWO', 'ONE');
  for (let i = 0; i < 16; i++) await h.frame();
  assert.equal(h.get('resultValue').textContent, 'TWO');
  assert.equal(scrolls, 0);
  assert.equal(h.tracks.length, 1);
  assert.equal(h.tracks[0].readyState, 'live');
});

for (const stale of [false, true]) test(`the next link opens if the native decoder keeps returning ${stale ? 'the old code' : 'empty frames'}`, async () => {
  let afterBack = false;
  const h = await app({ nativeDetect: codes => afterBack ? (stale ? [{ rawValue: firstLink }] : []) : codes });
  h.codes(firstLink); await h.frame();
  h.windowEvents.pagehide(); h.context.location.href = scannerURL;
  afterBack = true;
  h.windowEvents.pageshow({ persisted: true }); await flush();
  h.codes(nextLink);
  for (let i = 0; i < 24 && h.visits.length === 1; i++) await h.frame();
  assert.deepEqual(h.visits, [firstLink, nextLink]);
  assert.equal(h.tracks.length, 2);
});

test('a single blank read and time spent in the background cannot release the previous QR', async () => {
  const h = await app({ historyState: { qrReturnValue: firstLink } });
  h.codes(firstLink); await h.frame();
  h.codes(null); await h.frame(); await h.frame();
  h.visibility(true); h.advance(60000); h.visibility(false); await flush();
  await h.frame(); h.advance(60000); await h.frame();
  h.codes(firstLink); await h.frame();
  assert.deepEqual(h.visits, []);
});

test('Back into a rebuilt document keeps the decoder that recovered the previous scan', async () => {
  const first = await app({ historyState: { qrReturnValue: firstLink },
    nativeDetect: () => [{ rawValue: firstLink }] });
  first.codes(nextLink);
  for (let i = 0; i < 20 && !first.visits.length; i++) await first.frame();
  assert.deepEqual(first.visits, [nextLink]);
  let nativeCalls = 0;
  const again = await app({ historyState: structuredClone(first.context.history.state),
    nativeDetect() { nativeCalls++; return [{ rawValue: firstLink }]; } });
  again.codes(nextLink); await again.frame();
  again.codes(null);
  for (let i = 0; i < 18; i++) await again.frame();
  again.codes(nextLink); await again.frame();
  assert.deepEqual(again.visits, [nextLink]);
  assert.equal(nativeCalls, 0);
});

test('the next QR is read on the same live camera when video callbacks stop but playback advances', async () => {
  const h = await app();
  h.codes('FIRST'); await h.frame();
  h.advance(4200); h.get('video').currentTime += 4.2;
  h.runTimer(4000);
  h.codes('NEXT'); await h.frame();
  assert.equal(h.get('resultValue').textContent, 'NEXT');
  assert.equal(h.tracks.length, 1);
  assert.equal(h.tracks[0].readyState, 'live');
  h.get('cameraButton').fire('click');
  assert.equal(h.frameCount, 0);
});

test('a manually stopped camera stays stopped through hidden and visible history restores', async () => {
  const h = await app({ historyState: { qrReturnValue: firstLink } });
  h.get('cameraButton').fire('click');
  h.windowEvents.pagehide(); h.visibility(true);
  h.windowEvents.pageshow({ persisted: true });
  h.windowEvents.popstate({ state: h.context.history.state });
  h.visibility(false); await flush();
  assert.equal(h.tracks.length, 1);
  assert.equal(h.tracks[0].readyState, 'ended');
});

test('a failed history update still opens the link and protects a live document on return', async () => {
  const h = await app({ setup(c) {
    c.history.replaceState = () => { throw new DOMException('History unavailable', 'SecurityError'); };
  } });
  h.codes(firstLink); await h.frame();
  h.visibility(true); h.context.location.href = scannerURL; h.visibility(false); await flush();
  h.advance(9000); await h.frame();
  assert.deepEqual(h.visits, [firstLink]);
  assert.equal(h.tracks.at(-1).readyState, 'live');
});

for (const silent of [false, true]) test(`a ${silent ? 'silently cancelled' : 'rejected'} navigation leaves a manual link and a working scanner`, async () => {
  const h = await app();
  const assign = h.context.location.assign;
  h.context.location.assign = () => { if (!silent) throw new DOMException('Blocked', 'SecurityError'); };
  h.codes(firstLink); await h.frame();
  if (silent) h.runTimer(5000);
  await flush();
  assert.equal(h.get('stage')['data-state'], 'scanning');
  assert.equal(h.get('openLink').hidden, false);
  assert.equal(h.get('openLink').href, firstLink);
  await h.frame(); assert.deepEqual(h.visits, []);
  h.context.location.assign = assign;
  h.codes(nextLink); await h.frame();
  assert.deepEqual(h.visits, [nextLink]);
});

test('a stalled enumeration falls back to the browser rear camera and starts the scanner', async () => {
  const h = await app({ setup(c) {
    c.navigator.mediaDevices.enumerateDevices = () => new Promise(() => {});
  } });
  h.runTimer(1200); await flush();
  assert.equal(h.tracks.length, 1);
  h.runTimer(1200); await flush();
  assert.equal(h.get('stage')['data-state'], 'scanning');
  assert.equal(h.tracks[0].getSettings().facingMode, 'environment');
  assert.equal(h.frameCount, 1);
});

for (const manuallyCancel of [true, false]) test(`a ${manuallyCancel ? 'cancelled' : 'timed out'} camera request releases a late stream without disturbing the retry`, async () => {
  let deliver;
  const h = await app({ setup(c) {
    const devices = c.navigator.mediaDevices;
    const acquire = devices.getUserMedia;
    devices.getUserMedia = constraints => {
      devices.getUserMedia = acquire;
      return new Promise(resolve => { deliver = () => resolve(acquire(constraints)); });
    };
  } });
  assert.equal(h.get('cameraButton').disabled, false);
  if (manuallyCancel) h.get('cameraButton').fire('click');
  else h.runTimer(20000);
  await flush();
  assert.equal(h.get('stage')['data-state'], manuallyCancel ? 'idle' : 'error');
  h.get('cameraButton').fire('click'); await flush();
  const active = h.tracks[0];
  deliver(); await flush();
  assert.equal(h.tracks.at(-1).readyState, 'ended');
  assert.equal(active.readyState, 'live');
  assert.equal(h.get('video').srcObject.getVideoTracks()[0], active);
  assert.equal(h.frameCount, 1);
});

test('a stuck video play releases the camera, then a retry can scan even if old play resolves later', async () => {
  let finish;
  const h = await app({ setup(c) {
    const video = c.document.getElementById('video');
    video.play = () => {
      video.play = async () => {};
      return new Promise(resolve => { finish = resolve; });
    };
  } });
  assert.equal(h.tracks[0].readyState, 'live');
  h.runTimer(6000); await flush();
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.get('video').srcObject, null);
  assert.equal(h.get('stage')['data-state'], 'error');
  h.get('cameraButton').fire('click'); await flush();
  finish(); await flush();
  h.codes('RECOVERED'); await h.frame();
  assert.equal(h.get('resultValue').textContent, 'RECOVERED');
  assert.equal(h.tracks.filter(track => track.readyState === 'live').length, 1);
});

test('a briefly busy camera on Back retries after a delay and scans without a tap', async () => {
  const h = await app();
  h.codes(firstLink); await h.frame(); h.windowEvents.pagehide();
  const devices = h.context.navigator.mediaDevices;
  const acquire = devices.getUserMedia;
  devices.getUserMedia = async () => { throw new DOMException('Busy', 'NotReadableError'); };
  h.context.location.href = scannerURL;
  h.windowEvents.pageshow({ persisted: true }); await flush();
  assert.equal(h.tracks.length, 1);
  assert.equal(h.get('stage')['data-state'], 'opening');
  devices.getUserMedia = acquire;
  h.runTimer(500); await flush();
  assert.equal(h.tracks.at(-1).readyState, 'live');
  h.codes(nextLink); await h.frame();
  assert.deepEqual(h.visits, [firstLink, nextLink]);
});

test('persistent camera loss stops after two delayed retries and manual retry resets the budget', async () => {
  const h = await app();
  const devices = h.context.navigator.mediaDevices;
  const acquire = devices.getUserMedia;
  devices.getUserMedia = async () => { throw new DOMException('Busy', 'NotReadableError'); };
  h.tracks[0].fire('ended');
  h.runTimer(500); await flush();
  h.runTimer(1200); await flush();
  assert.equal(h.get('stage')['data-state'], 'error');
  assert.equal(h.hasTimer(500) || h.hasTimer(1200), false);
  devices.getUserMedia = acquire;
  h.get('cameraButton').fire('click'); await flush();
  assert.equal(h.tracks.at(-1).readyState, 'live');
  h.tracks.at(-1).fire('ended');
  assert.equal(h.hasTimer(500), true);
  h.get('cameraButton').fire('click');
  assert.equal(h.hasTimer(500), false);
});

for (const frozen of [false, true]) test(`a preview with ${frozen ? 'repeated timestamps' : 'no callbacks'} reconnects, and pausing cancels frame monitoring`, async () => {
  const h = await app();
  if (frozen) { await h.frame(1); await h.frame(1); }
  h.advance(4100); h.runTimer(4000);
  assert.equal(h.tracks[0].readyState, 'ended');
  h.runTimer(500); await flush();
  const recovered = h.tracks.at(-1);
  assert.equal(recovered.readyState, 'live');
  h.codes('RECOVERED'); await h.frame();
  assert.equal(h.get('resultValue').textContent, 'RECOVERED');
  h.visibility(true);
  assert.equal(h.hasTimer(4000), false);
  assert.equal(recovered.readyState, 'ended');
});

for (const stopEarly of [true, false]) test(`a stalled fallback script is recoverable ${stopEarly ? 'immediately after manual stop' : 'after its deadline'}`, async () => {
  let loads = 0;
  let firstScript;
  const h = await app({ native: false, workerFails: true, scriptLoader(script, context, decoder) {
    if (++loads === 1) { firstScript = script; return; }
    context.jsQR = decoder;
    queueMicrotask(script.onload);
  } });
  h.codes('OLD'); const pending = h.frame(); await flush();
  assert.equal(h.hasTimer(4500), true);
  if (stopEarly) h.get('cameraButton').fire('click');
  else h.runTimer(4500);
  await pending;
  assert.equal(h.get('stage')['data-state'], stopEarly ? 'idle' : 'error');
  assert.equal(h.hasTimer(4500), false);
  assert.equal(firstScript.onload, null);
  assert.equal(h.get('resultValue').textContent, '');
  h.get('cameraButton').fire('click'); await flush();
  h.codes('NEW'); await h.frame();
  assert.equal(h.get('resultValue').textContent, 'NEW');
  assert.equal(h.tracks.at(-1).readyState, 'live');
});

test('empty history is visible only inside its expanded state, including after clearing saved scans', async () => {
  const h = await app();
  h.windowEvents.pageshow({ persisted: false });
  assert.equal(h.get('emptyHistory').hidden, true);
  h.get('historyToggle').fire('click');
  assert.equal(h.get('emptyHistory').hidden, false);
  h.codes('SAVED'); await h.frame();
  assert.equal(h.get('emptyHistory').hidden, true);
  assert.equal(h.get('clearButton').hidden, false);
  h.get('clearButton').fire('click');
  assert.equal(h.get('emptyHistory').hidden, false);
  assert.equal(h.get('clearButton').hidden, true);
  h.get('historyToggle').fire('click');
  assert.equal(h.get('emptyHistory').hidden, true);
});
test('a backgrounded image read cannot open a stale URL on return', async () => {
  const h = await app();
  let finish;
  let closed = false;
  h.context.createImageBitmap = () => new Promise(resolve => {
    finish = () => resolve({ width: 200, height: 200, close() { closed = true; } });
  });
  h.get('fileInput').files = [{}]; h.get('fileInput').fire('change');
  assert.equal(h.get('stage')['data-state'], 'reading');
  h.visibility(true); h.visibility(false); await flush();
  h.codes(firstLink); finish(); await flush();
  assert.equal(closed, true);
  assert.deepEqual(h.visits, []);
  assert.equal(h.tracks.at(-1).readyState, 'live');
  h.codes(nextLink); await h.frame();
  assert.deepEqual(h.visits, [nextLink]);
});

test('old track events cannot cancel recovery for a newly muted camera', async () => {
  const h = await app();
  const old = h.tracks[0];
  h.visibility(true); h.visibility(false); await flush();
  const current = h.tracks.at(-1);
  current.muted = true; current.fire('mute'); old.fire('unmute');
  h.runTimer(1400); await flush();
  assert.equal(current.readyState, 'ended');
  h.runTimer(500); await flush();
  assert.equal(h.tracks.at(-1).readyState, 'live');
});
