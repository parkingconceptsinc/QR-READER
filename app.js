const $ = id => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const status = $('status');
let stream = null;
let detector = null;
let scanning = false;
let facingMode = 'environment';
let session = 0;
let starting = false;
let resumeOnVisible = false;
let navigating = false;
let manuallyStopped = false;
let installPrompt = null;
let lastScanAt = 0;
let detectorBusy = false;
let lastDecodedValue = '';
let lastDecodedAt = 0;
let restartTimer = null;
const historyKey = 'lector-qr-history-v1';
const decoderUrl = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

function fallbackDetector() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const ready = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = decoderUrl;
    script.async = true;
    script.onload = () => {
      resolve();
      if ('caches' in window) caches.open('pci-qr-decoder-v1').then(cache => cache.add(decoderUrl)).catch(() => {});
    };
    script.onerror = () => reject(new Error('Could not load the QR scanner. Connect to the internet and reload.'));
    document.head.append(script);
  });
  ready.catch(() => {});
  return {
    async detect(source) {
      await ready;
      const width = source.videoWidth || source.width;
      const height = source.videoHeight || source.height;
      const scale = Math.min(1, (source === video ? 720 : 1600) / Math.max(width, height));
      const targetWidth = Math.round(width * scale);
      const targetHeight = Math.round(height * scale);
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
      return code ? [{ rawValue: code.data }] : [];
    }
  };
}

function say(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(historyKey)) || []; }
  catch { return []; }
}

function renderHistory() {
  const items = getHistory();
  $('historyList').replaceChildren();
  $('emptyHistory').hidden = items.length > 0 || !$('historyWrap').hidden;
  $('clearButton').hidden = items.length === 0 || $('historyWrap').hidden;
  $('historyToggle').textContent = $('historyWrap').hidden ? `Show${items.length ? ` (${items.length})` : ''}` : 'Hide';
  $('historyToggle').setAttribute('aria-expanded', String(!$('historyWrap').hidden));
  for (const item of items) {
    const li = document.createElement('li');
    const value = document.createElement('span');
    value.textContent = item.value;
    value.title = item.value;
    const time = document.createElement('time');
    time.textContent = new Date(item.time).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
    li.append(value, time);
    li.addEventListener('click', () => showResult(item.value, false));
    $('historyList').append(li);
  }
}

function showResult(value, save = true) {
  const url = safeUrl(value);
  if (save) {
    const items = getHistory().filter(item => item.value !== value);
    items.unshift({ value, time: Date.now() });
    try { localStorage.setItem(historyKey, JSON.stringify(items.slice(0, 10))); } catch {}
    renderHistory();
    if (navigator.vibrate) navigator.vibrate(80);
  }
  if (save && url) {
    if (navigating) return;
    navigating = true;
    // Preserve a scanner entry in the browser history before opening the QR URL.
    // Android Back should return to this exact scanner page and restart its camera.
    history.pushState({ qrScanner: true }, '', location.href);
    stopCamera();
    window.location.assign(url);
    return;
  }
  $('resultValue').textContent = value;
  $('result').hidden = false;
  $('openLink').hidden = !url;
  if (url) $('openLink').href = url;
  say('QR code detected.');
  $('result').scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

function stopCamera() {
  session++;
  starting = false;
  scanning = false;
  $('cameraButton').disabled = false;
  $('torchButton').classList.remove('on');
  $('torchButton').setAttribute('aria-label', 'Turn flashlight on');
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  stage.classList.remove('active');
  $('liveBadge').hidden = true;
  $('switchButton').hidden = true;
  $('torchButton').hidden = true;
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Start scanning';
  $('cameraHint').textContent = 'Camera ready · Scan again instantly';
}

async function startCamera(force = false) {
  if (force) manuallyStopped = false;
  if (manuallyStopped || starting || scanning || document.hidden || navigating) return;
  if (!detector) return say('This browser does not support QR scanning. Try an up-to-date version of Chrome or Edge.', true);
  if (!navigator.mediaDevices?.getUserMedia) return say('Camera access requires HTTPS or localhost.', true);
  stopCamera();
  const activeSession = session;
  starting = true;
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Opening camera…';
  $('cameraButton').disabled = true;
  say('Opening camera…');
  try {
    const videoConstraints = { facingMode: { exact: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } };
    let openedStream;
    try {
      openedStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (cameraError) {
      // Keep permission/security errors visible, but retry camera selection more broadly for Android devices.
      if (cameraError.name === 'NotAllowedError' || cameraError.name === 'SecurityError') throw cameraError;
      openedStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    }
    if (activeSession !== session) { openedStream.getTracks().forEach(track => track.stop()); return; }
    stream = openedStream;
    video.srcObject = stream;
    await video.play();
    if (activeSession !== session) return;
    starting = false;
    scanning = true;
    $('cameraButton').disabled = false;
    stage.classList.add('active');
    $('liveBadge').hidden = false;
    $('switchButton').hidden = false;
    $('torchButton').hidden = !stream.getVideoTracks()[0].getCapabilities?.().torch;
    $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Stop scanning';
    $('cameraHint').textContent = 'Center the code · Scan again whenever you're ready';
    say('Scanning automatically. Point at a QR code.');
    scheduleScan(activeSession);
  } catch (error) {
    if (activeSession !== session) return;
    stopCamera();
    const message = error.name === 'NotAllowedError' || error.name === 'SecurityError'
      ? 'Camera permission is blocked. Allow camera access in your browser settings, then tap Start scanning.'
      : error.name === 'NotFoundError'
        ? 'No camera was found on this device.'
        : error.name === 'NotReadableError'
          ? 'The camera is busy. Close other apps using it, then tap Start scanning.'
          : 'Camera could not start. Check permission and try Start scanning again.';
    say(message, true);
    $('cameraHint').textContent = 'Camera could not start · Check permission and retry';
  }
}

function scheduleScan(activeSession) {
  if (!scanning || activeSession !== session) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => scanFrame(activeSession));
  else requestAnimationFrame(() => scanFrame(activeSession));
}

async function scanFrame(activeSession) {
  if (!scanning || activeSession !== session) return;
  const now = performance.now();
  if (detectorBusy) return;
  if (now - lastScanAt < 90) { scheduleScan(activeSession); return; }
  if (video.readyState >= 2) {
    detectorBusy = true;
    lastScanAt = now;
    try {
      const codes = await detector.detect(video);
      detectorBusy = false;
      if (!scanning || activeSession !== session) return;
      if (codes.length) {
        const value = codes[0].rawValue;
        const time = Date.now();
        if (value === lastDecodedValue && time - lastDecodedAt < 3500) {
          scheduleScan(activeSession);
          return;
        }
        lastDecodedValue = value;
        lastDecodedAt = time;
        stopCamera();
        showResult(value);
        // Non-URL QR codes remain in the scanner and the camera resumes quickly.
        if (!safeUrl(value)) {
          clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            if (!document.hidden) startCamera();
          }, 350);
        }
        return;
      }
    } catch (error) {
      detectorBusy = false;
      if (activeSession !== session) return;
      if (error.name === 'NotSupportedError') detector = fallbackDetector();
      if (error.message?.startsWith('Could not load')) {
        say(error.message, true);
        stopCamera();
      }
    }
  }
  scheduleScan(activeSession);
}

async function readFile(file) {
  if (!file) return;
  if (!detector) return say('This browser does not support QR scanning. Try an up-to-date version of Chrome or Edge.', true);
  stopCamera();
  say('Reading the image…');
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const codes = await detector.detect(bitmap);
      if (codes.length) {
        showResult(codes[0].rawValue);
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (!document.hidden) startCamera();
        }, 650);
      } else say('No QR code was found in the image.', true);
    } finally { bitmap.close(); }
  } catch { say('Could not read the image. Choose a valid image file.', true); }
}

$('cameraButton').addEventListener('click', () => {
  if (scanning) {
    manuallyStopped = true;
    stopCamera();
    say('Camera stopped.');
  } else startCamera(true);
});
$('switchButton').addEventListener('click', () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  stopCamera();
  startCamera();
});
$('torchButton').addEventListener('click', async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const on = !$('torchButton').classList.contains('on');
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    $('torchButton').classList.toggle('on', on);
    $('torchButton').setAttribute('aria-label', on ? 'Turn flashlight off' : 'Turn flashlight on');
  } catch { say('The flashlight is not available on this camera.', true); }
});
$('fileInput').addEventListener('change', event => {
  readFile(event.target.files[0]);
  event.target.value = '';
});
$('copyButton').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('resultValue').textContent); say('Content copied.'); }
  catch { say('Could not copy the content.', true); }
});
$('historyToggle').addEventListener('click', () => {
  const opening = $('historyWrap').hidden;
  $('historyWrap').hidden = !opening;
  renderHistory();
});
$('clearButton').addEventListener('click', () => {
  localStorage.removeItem(historyKey);
  renderHistory();
  say('History cleared.');
});
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('install').hidden = true;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // A QR link may hand off to another app; preserve the intent to resume on return.
    resumeOnVisible = !manuallyStopped && (scanning || starting || navigating);
    stopCamera();
  } else if (resumeOnVisible && !manuallyStopped) {
    resumeOnVisible = false;
    navigating = false;
    startCamera();
  }
});
window.addEventListener('popstate', event => {
  if (event.state?.qrScanner || navigating) {
    navigating = false;
    resumeOnVisible = false;
    $('result').hidden = true;
    say('Ready for the next scan.');
    if (!manuallyStopped) startCamera();
  }
});
window.addEventListener('pagehide', stopCamera);
window.addEventListener('pageshow', () => {
  navigating = false;
  if (!document.hidden && !manuallyStopped) startCamera();
});

if ('BarcodeDetector' in window) {
  try { detector = new BarcodeDetector({ formats: ['qr_code'] }); }
  catch { detector = fallbackDetector(); }
} else detector = fallbackDetector();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').then(registration => registration.update()).catch(() => {});
renderHistory();
startCamera();
