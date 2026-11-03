const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const fixture = require('./fixtures/qr-v33.json');

function startWorker(t) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    global.self = global;
    global.importScripts = () => { global.jsQR = require(workerData.decoder); };
    self.postMessage = value => parentPort.postMessage(value);
    require('node:vm').runInThisContext(require('node:fs').readFileSync(workerData.source, 'utf8'));
    parentPort.on('message', data => self.onmessage({ data }));
  `, { eval: true, workerData: {
    decoder: require.resolve('../vendor/jsQR.js'), source: require.resolve('../scan-worker.js')
  } });
  t.after(() => worker.terminate());
  return worker;
}

function pixels(scale = 4, inverted = false) {
  const size = fixture.rows.length * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const black = fixture.rows[Math.floor(y / scale)][Math.floor(x / scale)] === '1';
    const value = black !== inverted ? 0 : 255;
    const offset = (y * size + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { width: size, height: size, buffer: data.buffer };
}

function send(worker, message) {
  return new Promise((resolve, reject) => {
    const onMessage = data => { worker.off('error', onError); resolve(data); };
    const onError = error => { worker.off('message', onMessage); reject(error); };
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.postMessage(message, [message.buffer]);
  });
}

for (const inverted of [false, true]) test(`threaded decoder reads a real ${inverted ? 'inverted' : 'normal'} QR fixture`, async t => {
  const worker = startWorker(t);
  const frame = pixels(6, inverted);
  const pending = send(worker, { id: 1, ...frame, inversionAttempts: 'attemptBoth' });
  assert.equal(frame.buffer.byteLength, 0, 'pixel ownership transfers off the caller thread');
  const result = await pending;
  assert.equal(result.id, 1);
  assert.equal(result.codes[0].rawValue, fixture.text);
});

test('malformed frame errors do not kill the worker or corrupt subsequent decoding', async t => {
  const worker = startWorker(t);
  const error = await send(worker, { id: 1, width: 100, height: 100, buffer: new ArrayBuffer(8) });
  assert.equal(error.id, 1);
  assert.match(error.error, /Invalid QR frame/);
  const result = await send(worker, { id: 2, ...pixels(), inversionAttempts: 'dontInvert' });
  assert.equal(result.codes[0].rawValue, fixture.text);
});

test('blank frames return no false code', async t => {
  const worker = startWorker(t);
  const result = await send(worker, { id: 1, width: 80, height: 80,
    buffer: new Uint8ClampedArray(80 * 80 * 4).fill(255).buffer, inversionAttempts: 'attemptBoth' });
  assert.deepEqual(result.codes, []);
});
