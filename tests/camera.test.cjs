const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ DOMException });
vm.runInContext(readFileSync(require.resolve('../camera.js'), 'utf8'), context);
const camera = context.QRCamera;
const device = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });
const lenses = [device('front', 'Front camera'), device('ultra', 'Back Ultra Wide Camera'),
  device('main', 'Back Wide Camera'), device('tele', 'Back Telephoto Camera')];

function streamFor(id, label = id) {
  const track = { label, readyState: 'live', stop() { this.readyState = 'ended'; },
    getSettings: () => ({ deviceId: id, facingMode: id === 'front' ? 'user' : 'environment' }) };
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}

test('prefers the primary rear lens over ultra wide, telephoto, macro and virtual lenses', () => {
  const devices = [...lenses, device('macro', 'Rear Macro'), device('virtual', 'Back Triple Camera')];
  assert.equal(camera.choose(devices, 'environment').deviceId, 'main');
  assert.equal(camera.choose(devices, 'user').deviceId, 'front');
  assert.equal(camera.choose([device('m', 'Cámara trasera principal'), ...lenses], 'environment').deviceId, 'm');
});

test('anonymous labels do not turn enumeration order into a camera preference', () => {
  assert.equal(camera.choose([device('a', ''), device('b', '')], 'environment'), null);
});

test('generic camera labels can be ranked by exposed rear-facing and focus capabilities', () => {
  const fixed = { ...device('fixed', 'camera2 2, facing back'),
    getCapabilities: () => ({ facingMode: ['environment'], width: { max: 1280 }, height: { max: 720 } }) };
  const focused = { ...device('focused', 'camera2 0, facing back'),
    getCapabilities: () => ({ facingMode: ['environment'], focusMode: ['continuous'], width: { max: 1920 }, height: { max: 1080 } }) };
  assert.equal(camera.choose([fixed, focused], 'environment').deviceId, 'focused');
  assert.equal(camera.choose([{ ...fixed, label: '' }, { ...focused, label: '' }], 'environment').deviceId, 'focused');
  const throws = { ...fixed, getCapabilities() { throw new Error('Unavailable'); } };
  assert.equal(camera.choose([throws, focused], 'environment').deviceId, 'focused');
});

test('opens the primary lens directly when names are already exposed', async () => {
  const requests = [];
  const result = await camera.open({ facingMode: 'environment', mediaDevices: {
    enumerateDevices: async () => lenses,
    getUserMedia: async constraints => { requests.push(constraints); return streamFor('main'); }
  } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].video.deviceId.exact, 'main');
  assert.equal(requests[0].audio, false);
  assert.equal(result.stream.getVideoTracks()[0].readyState, 'live');
});

test('uses labels unlocked by permission and releases the wrong lens before switching', async () => {
  let granted = false;
  const first = streamFor('ultra', 'Back Ultra Wide Camera');
  const result = await camera.open({ facingMode: 'environment', mediaDevices: {
    enumerateDevices: async () => granted ? lenses : [device('ultra', ''), device('main', '')],
    getUserMedia: async constraints => {
      if (!granted) { granted = true; return first; }
      assert.equal(first.getVideoTracks()[0].readyState, 'ended');
      assert.equal(constraints.video.deviceId.exact, 'main');
      return streamFor('main');
    }
  } });
  assert.equal(result.stream.getVideoTracks()[0].getSettings().deviceId, 'main');
});

test('a manual lens selection survives automatic ranking', async () => {
  const result = await camera.open({ facingMode: 'environment', deviceId: 'tele', mediaDevices: {
    enumerateDevices: async () => lenses,
    getUserMedia: async constraints => streamFor(constraints.video.deviceId.exact)
  } });
  assert.equal(result.stream.getVideoTracks()[0].getSettings().deviceId, 'tele');
});

test('a removed or unusable preferred lens falls back to the browser rear camera', async () => {
  for (const errorName of ['NotFoundError', 'OverconstrainedError', 'NotReadableError']) {
    const result = await camera.open({ facingMode: 'environment', deviceId: 'gone', mediaDevices: {
      enumerateDevices: async () => lenses,
      getUserMedia: async constraints => {
        if (constraints.video.deviceId) throw new DOMException('Missing camera', errorName);
        assert.equal(constraints.video.facingMode.ideal, 'environment');
        return streamFor('main');
      }
    } });
    assert.equal(result.stream.getVideoTracks()[0].readyState, 'live');
  }
});

test('a denied permission is reported once without retry prompts', async () => {
  let attempts = 0;
  await assert.rejects(camera.open({ facingMode: 'environment', mediaDevices: {
    enumerateDevices: async () => [],
    getUserMedia: async () => { attempts++; throw new DOMException('Denied', 'NotAllowedError'); }
  } }), { name: 'NotAllowedError' });
  assert.equal(attempts, 1);
});

test('enumeration failure still allows scanning with the browser default', async () => {
  const result = await camera.open({ facingMode: 'environment', mediaDevices: {
    enumerateDevices: async () => { throw new Error('Unavailable'); },
    getUserMedia: async () => streamFor('default')
  } });
  assert.equal(result.stream.getVideoTracks()[0].readyState, 'live');
});

test('a cancelled pending camera request closes the stream when it resolves', async () => {
  const opened = streamFor('main');
  let current = true;
  await assert.rejects(camera.open({ facingMode: 'environment', isCurrent: () => current, mediaDevices: {
    enumerateDevices: async () => lenses,
    getUserMedia: async () => { current = false; return opened; }
  } }), { name: 'AbortError' });
  assert.equal(opened.getVideoTracks()[0].readyState, 'ended');
});

test('tuning retains autofocus when exposure is rejected and white balance succeeds', async () => {
  const requests = [];
  await camera.tune({ readyState: 'live',
    getConstraints: () => ({ width: { ideal: 1920 } }),
    getCapabilities: () => ({ focusMode: ['continuous', 'manual'], exposureMode: ['continuous'], whiteBalanceMode: ['continuous'] }),
    applyConstraints: async constraints => {
      requests.push(constraints);
      if (constraints.advanced[0].exposureMode) throw new Error('Unsupported combination');
    }
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].advanced[0].focusMode, 'continuous');
  assert.equal(requests[2].advanced[0].whiteBalanceMode, 'continuous');
  assert.equal(requests[2].advanced[0].exposureMode, undefined);
  assert.equal(requests[2].width.ideal, 1920);
});

test('tuning tolerates missing controls and stops touching a cancelled session', async () => {
  await camera.tune({});
  await camera.tune({ getCapabilities() { throw new Error('Unavailable'); } });
  let calls = 0;
  await camera.tune({ getCapabilities: () => ({ focusMode: ['continuous'] }),
    applyConstraints: async () => calls++ }, () => false);
  assert.equal(calls, 0);
});
