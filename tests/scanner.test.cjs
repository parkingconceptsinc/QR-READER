const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

function harness({ decode = async () => [], native = true } = {}) {
  let now = 0;
  let nextId = 0;
  let reads = 0;
  let draws = 0;
  let layouts = 0;
  const frames = new Map();
  const timers = new Map();
  const sizes = [];
  const results = [];
  const errors = [];
  const events = {};
  const rect = { left: 0, top: 0, width: 360, height: 560 };
  const stage = { getBoundingClientRect() { layouts++; return { ...rect }; } };
  const frame = { getBoundingClientRect() { layouts++; return { left: 60, top: 160, width: 240, height: 240 }; } };
  const video = { videoWidth: 3840, videoHeight: 2160, readyState: 4, currentTime: 0,
    requestVideoFrameCallback(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelVideoFrameCallback(id) { frames.delete(id); }
  };
  const context = vm.createContext({
    document: { createElement: () => {
      const canvas = { width: 1, height: 1 };
      const ctx = {
        drawImage() { draws++; },
        getImageData(x, y, width, height) {
          reads++;
          return { width, height, data: new Uint8ClampedArray(width * height * 4) };
        }
      };
      canvas.getContext = () => ctx;
      return canvas;
    } },
    addEventListener(type, callback) { events[type] = callback; },
    performance: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Worker: class {
      postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id, codes: [] } })); }
      terminate() {}
    }
  });
  context.window = context;
  if (native) context.BarcodeDetector = class {
    detect(source) { sizes.push([source.width, source.height]); return decode(source); }
  };
  vm.runInContext(readFileSync(require.resolve('../scanner.js'), 'utf8'), context);
  const scanner = context.QRScanner.create({ video, stage, frame,
    onResult: value => results.push(value), onError: error => errors.push(error) });
  return { scanner, video, results, errors, sizes, events,
    get reads() { return reads; }, get draws() { return draws; }, get layouts() { return layouts; },
    get scheduled() { return frames.size; },
    step(at, videoTime = at / 1000) {
      now = at; video.currentTime = videoTime;
      const entry = frames.entries().next().value;
      assert.ok(entry, 'the next frame is scheduled');
      frames.delete(entry[0]);
      return entry[1]();
    },
    timeout(delay) {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay);
      timers.delete(id); timer.callback();
    }
  };
}

test('ordinary native frames use a small crop without CPU readback, with detailed and wide recovery passes', async () => {
  const h = harness(); h.scanner.start();
  for (let i = 0; i < 6; i++) await h.step(i * 34);
  assert.equal(Math.max(...h.sizes[0]), 768);
  assert.ok(Math.max(...h.sizes[4]) > 768, 'a detailed crop still uses available camera detail');
  assert.equal(Math.max(...h.sizes[5]), 960);
  assert.equal(h.reads, 0);
  assert.equal(h.layouts, 2, 'preview layout is reused across nearby frames');
  h.events.resize(); await h.step(220);
  assert.equal(h.layouts, 4);
  h.scanner.stop(); assert.equal(h.scheduled, 0);
});

test('a frozen video frame is not decoded repeatedly and a new frame resumes detection', async () => {
  const h = harness(); h.scanner.start();
  await h.step(0, 1); await h.step(34, 1); await h.step(68, 1);
  assert.equal(h.sizes.length, 1);
  await h.step(102, 2);
  assert.equal(h.sizes.length, 2);
});

test('a late result from a stopped camera cannot navigate or stall the new camera session', async () => {
  let finish;
  let calls = 0;
  const h = harness({ decode: () => ++calls === 1 ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve([{ rawValue: 'NEW CAMERA' }]) });
  h.scanner.start(); const old = h.step(0);
  h.scanner.stop(); h.scanner.start();
  assert.equal(h.scheduled, 0, 'only one decode owns the pipeline');
  finish([{ rawValue: 'STALE CAMERA' }]); await old;
  assert.equal(h.results.length, 0);
  assert.equal(h.scheduled, 1);
  await h.step(34);
  assert.deepEqual(h.results, ['NEW CAMERA']);
  assert.equal(h.scheduled, 1);
});

test('a hung native decoder falls back without waiting forever or restarting the camera', async () => {
  const h = harness({ decode: () => new Promise(() => {}) });
  h.scanner.start(); const pending = h.step(0);
  h.timeout(1200); await pending;
  assert.equal(h.scanner.mode, 'worker');
  await h.step(1300);
  assert.equal(h.errors.length, 0);
  assert.equal(h.scheduled, 1);
});

test('threaded detection reads the crop directly and resumes on the next eligible frame', async () => {
  const h = harness({ native: false }); h.scanner.start();
  await h.step(0); await h.step(50);
  assert.equal(h.reads, 2);
  assert.equal(h.draws, 2, 'no extra full-canvas draw before transferring pixels');
  assert.equal(h.scheduled, 1);
});
