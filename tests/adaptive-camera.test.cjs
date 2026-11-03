const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ DOMException });
vm.runInContext(readFileSync(require.resolve('../camera.js'), 'utf8'), context);
const camera = context.QRCamera;
const flush = () => new Promise(setImmediate);
const device = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });

function makeTrack({ capabilities = {}, initial = {}, reject = () => false } = {}) {
  const settings = { deviceId: 'rear', facingMode: 'environment', width: 1920, height: 1080, ...initial };
  const requests = [];
  const track = { readyState: 'live', label: 'Back Main Camera',
    getSettings: () => ({ ...settings }), getCapabilities: () => capabilities,
    getConstraints: () => ({ deviceId: { exact: 'rear' }, width: { ideal: 1920 } }),
    applyConstraints: async constraints => {
      requests.push(structuredClone(constraints));
      if (reject(constraints)) throw new DOMException('Unsupported combination', 'OverconstrainedError');
      Object.assign(settings, constraints.advanced?.[0]);
      if (constraints.height?.ideal) { settings.width = constraints.width.ideal; settings.height = constraints.height.ideal; }
    }, stop() { this.readyState = 'ended'; }
  };
  return { track, settings, requests };
}

test('rear-only opening ignores a saved front lens and requests 4K without a hard fps limit', async () => {
  let request;
  const { track } = makeTrack();
  const result = await camera.open({ facingMode: 'environment', deviceId: 'front', mediaDevices: {
    enumerateDevices: async () => [device('front', 'Front Camera'), device('rear', 'Back Main Camera')],
    getUserMedia: async constraints => { request = constraints; return { getTracks: () => [track], getVideoTracks: () => [track] }; }
  } });
  assert.equal(request.video.deviceId.exact, 'rear');
  assert.equal(request.video.width.ideal, 3840);
  assert.equal(request.video.height.ideal, 2160);
  assert.equal(request.video.frameRate.max, undefined);
  assert.equal(result.stream.getVideoTracks()[0].getSettings().facingMode, 'environment');
});

test('a phone exposing only a front camera fails without opening it', async () => {
  let calls = 0;
  await assert.rejects(camera.open({ facingMode: 'environment', mediaDevices: {
    enumerateDevices: async () => [device('front', 'Front Camera')],
    getUserMedia: async () => { calls++; }
  } }), { name: 'NotFoundError' });
  assert.equal(calls, 0);
});

test('fallback streams reporting a front camera are closed and never returned', async () => {
  const opened = [];
  await assert.rejects(camera.open({ facingMode: 'environment', mediaDevices: {
    enumerateDevices: async () => [],
    getUserMedia: async () => {
      const { track } = makeTrack({ initial: { facingMode: 'user' } });
      opened.push(track);
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    }
  } }), { name: 'NotFoundError' });
  assert.ok(opened.length > 0);
  assert.ok(opened.every(track => track.readyState === 'ended'));
});

test('a browser ignoring facingMode can recover by a rear ID revealed after permission', async () => {
  let granted = false;
  const frontTrack = makeTrack({ initial: { facingMode: 'user' } }).track;
  const rearTrack = makeTrack().track;
  const result = await camera.open({ facingMode: 'environment', mediaDevices: {
    enumerateDevices: async () => granted ? [device('front', 'Front Camera'), device('rear', 'Back Main Camera')] : [],
    getUserMedia: async request => {
      const selected = request.video.deviceId?.exact;
      granted = true;
      const track = selected === 'rear' ? rearTrack : frontTrack;
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    }
  } });
  assert.equal(frontTrack.readyState, 'ended');
  assert.equal(result.stream.getVideoTracks()[0], rearTrack);
});

test('capability tuning increases detail and preserves camera identity and autofocus', async () => {
  const { track, settings, requests } = makeTrack({ capabilities: {
    width: { max: 3840 }, height: { max: 2160 }, resizeMode: ['none', 'crop-and-scale'],
    focusMode: ['continuous'], exposureMode: ['continuous'], whiteBalanceMode: ['continuous']
  } });
  const controller = camera.createController(track, { supported: { pointsOfInterest: true } });
  await controller.ready;
  assert.equal(settings.width, 3840);
  assert.equal(settings.height, 2160);
  assert.equal(settings.focusMode, 'continuous');
  assert.ok(requests.every(request => request.deviceId.exact === 'rear'));
  assert.equal(requests.at(-1).advanced[0].focusMode, 'continuous');
  assert.equal(requests.at(-1).advanced[0].exposureMode, 'continuous');
  assert.equal(requests.at(-1).advanced[0].whiteBalanceMode, 'continuous');
  assert.equal(requests.at(-1).resizeMode.ideal, 'none');
  assert.equal(settings.pointsOfInterest[0].x, 0.5);
});

test('portrait capture requests the corresponding native dimensions', async () => {
  const { track, settings } = makeTrack({ initial: { width: 1080, height: 1920 },
    capabilities: { width: { max: 2160 }, height: { max: 3840 } } });
  await camera.createController(track).ready;
  assert.equal(settings.width, 2160);
  assert.equal(settings.height, 3840);
});

test('a rejected higher resolution keeps the current working stream and focus', async () => {
  const { track, settings } = makeTrack({ capabilities: {
    width: { max: 3840 }, height: { max: 2160 }, focusMode: ['continuous']
  }, reject: request => request.height?.ideal === 2160 });
  await camera.createController(track).ready;
  assert.equal(settings.width, 1920);
  assert.equal(settings.focusMode, 'continuous');
  assert.equal(track.readyState, 'live');
});

test('native zoom honors the reported range and step without driving auto mode to maximum', () => {
  const range = { min: 1, max: 10, step: 0.25 };
  assert.equal(camera.zoomValue(100, range), 10);
  assert.equal(camera.zoomValue(-10, range), 1);
  assert.equal(camera.zoomValue(1.6, range), 1.5);
  assert.deepEqual([0, 1500, 3000, 4500, 6000].map(time => camera.autoZoom(time, range)), [1, 1.25, 1.75, 1, 1]);
  assert.ok(Array.from({ length: 30 }, (_, i) => camera.autoZoom(i * 500, range)).every(value => value <= 2));
});

test('automatic zoom, manual adjustment and automatic reset preserve autofocus', async () => {
  const { track, settings } = makeTrack({ initial: { zoom: 4 }, capabilities: {
    focusMode: ['continuous'], zoom: { min: 1, max: 10, step: 0.1 }
  } });
  const controller = camera.createController(track);
  await controller.ready;
  assert.equal(settings.zoom, 1);
  controller.tick(0); controller.tick(1600); await flush();
  assert.equal(settings.zoom, 1.4);
  await controller.setZoom(5);
  controller.tick(5000); await flush();
  assert.equal(settings.zoom, 5);
  assert.equal(controller.snapshot().automatic, false);
  await controller.setAutoZoom();
  assert.equal(settings.zoom, 1);
  assert.equal(settings.focusMode, 'continuous');
  assert.equal(controller.snapshot().automatic, true);
});

test('a rejected zoom control disables only zoom and leaves focusing available', async () => {
  const { track, settings } = makeTrack({ initial: { zoom: 1 }, capabilities: {
    focusMode: ['continuous'], zoom: { min: 1, max: 8, step: 0.1 }
  }, reject: request => Boolean(request.advanced?.[0].zoom) });
  const controller = camera.createController(track);
  await controller.ready;
  assert.equal(controller.snapshot().zoom, null);
  assert.equal(controller.snapshot().canFocus, true);
  assert.equal(settings.focusMode, 'continuous');
  assert.equal(track.readyState, 'live');
  await controller.refocus();
  assert.equal(settings.focusMode, 'continuous');
});

test('zoom without permission-exposed settings is left alone', async () => {
  const { track, requests } = makeTrack({ capabilities: { zoom: { min: 1, max: 10 } } });
  const controller = camera.createController(track);
  await controller.ready;
  assert.equal(controller.snapshot().zoom, null);
  controller.tick(2000); await controller.setZoom(2);
  assert.equal(requests.length, 0);
});

test('rapid slider input coalesces while all hardware changes stay sequential', async () => {
  const { track, settings, requests } = makeTrack({ initial: { zoom: 1 }, capabilities: {
    zoom: { min: 1, max: 10, step: 0.1 }
  } });
  const apply = track.applyConstraints;
  let busy = false;
  track.applyConstraints = async request => {
    assert.equal(busy, false);
    busy = true; await flush(); await apply(request); busy = false;
  };
  const controller = camera.createController(track);
  await controller.ready;
  requests.length = 0;
  await Promise.all([controller.setZoom(2), controller.setZoom(3), controller.setZoom(4), controller.setZoom(5)]);
  assert.equal(settings.zoom, 5);
  assert.ok(requests.length <= 2);
  const pending = controller.setZoom(6);
  await controller.setAutoZoom(); await pending;
  assert.equal(settings.zoom, 1);
  assert.equal(controller.snapshot().automatic, true);
});

test('tap focus normalizes the point and preserves the current zoom', async () => {
  const { track, settings } = makeTrack({ initial: { zoom: 1 }, capabilities: {
    focusMode: ['single-shot'], zoom: { min: 1, max: 4, step: 0.1 }
  } });
  const controller = camera.createController(track, { supported: { pointsOfInterest: true } });
  await controller.ready; await controller.setZoom(2);
  await controller.refocus({ x: -1, y: 3 });
  assert.equal(settings.pointsOfInterest[0].x, 0);
  assert.equal(settings.pointsOfInterest[0].y, 1);
  assert.equal(settings.focusMode, 'single-shot');
  assert.equal(settings.zoom, 2);
});

test('stopping or cancelling a controller prevents subsequent hardware changes', async () => {
  const { track, requests } = makeTrack({ initial: { zoom: 1 }, capabilities: {
    focusMode: ['continuous'], zoom: { min: 1, max: 4, step: 0.1 }
  } });
  const controller = camera.createController(track);
  await controller.ready;
  controller.stop();
  const before = requests.length;
  await controller.setZoom(3); await controller.refocus(); controller.tick(10000);
  assert.equal(requests.length, before);
});
