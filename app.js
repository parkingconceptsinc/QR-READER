const $ = id => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const status = $('status');
let stream = null;
let detector = null;
let detectorMode = 'none';
let decoderFailed = false;
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
const decoderUrl = './vendor/jsQR.js';
const LIVE_SCAN_INTERVAL_MS = 55;
const FALLBACK_MAX_DIMENSION = 640;

function fallbackDetector() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let frameCount = 0;
  const ready = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = decoderUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('The built-in QR decoder could not load. Reload PCI QR Reader and try again.'));
    document.head.append(script);
  });
  ready.catch(() => {});
  return {
    async detect(source) {
      await ready;
      if (!window.jsQR || !context) throw new Error('The built-in QR decoder is unavailable.');
      const width = source.videoWidth || source.width;
      const height = source.videoHeight || source.height;
      if (!width || !height) return [];
      const isLiveVideo = source === video;
      const maxDimension = isLiveVideo ? FALLBACK_MAX_DIMENSION : 1600;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      context.drawImage(source, 0, 0, targetWidth, targetHeight);
      const pixels = context.getImageData(0, 0, targetWidth, targetHeight);
      // Most QR codes are normally oriented. Check inverted codes periodically to
      // keep routine frames fast without losing support for unusual labels.
      const inversionAttempts = !isLiveVideo || ++frameCount % 5 === 0 ? 'attemptBoth' : 'dontInvert';
      const code = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts });
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
  if (force) {
    manuallyStopped = false;
    if (decoderFailed && detectorMode === 'jsqr') {
      detectorFailed = false;
      detector = fallbackDetector();
    }
  }
  if (manuallyStopped || starting || scanning || document.hidden || navigating) return;
  if (!detector) return say('This browser does not support QR scanning. Try an up-to-date version of Chrome or Edge.', true);
  if (!navigator.mediaDevices?.getUserMedia) return say('Camera access requires HTTPS or localhost.', true);
  stopCamera();
  const activeSession = session;
  starting = true;
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Opening camera…';
  $('cameraButton').disabled = true;
  say('Requesting camera access…');
  try {
    // Prefer the rear camera without requiring an exact match; strict constraints can
    // reject valid Android camera devices and leave the preview blank.
    const videoConstraints = {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    };
    let openedStream;
    try {
      openedStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (cameraError) {
      if (!['OverconstrainedError', 'NotFoundError'].includes(cameraError.name)) throw cameraError;
      try {
        openedStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facingMode } }
        });
      } catch (fallbackError) {
        if (!['OverconstrainedError', 'NotFoundError'].includes(fallbackError.name)) throw fallbackError;
        openedStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
    }
    if (activeSession !== session) { openedStream.getTracks().forEach(track => track.stop()); return; }
    stream = openedStream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await video.play();
    if (activeSession !== session) return;
    starting = false;
    scanning = true;
    $('cameraButton').disabled = false;
    stage.classList.add('active');
    $('liveBadge').hidden = false;
    $('switchButton').hidden = false;
    let torchAvailable = false;
    try { torchAvailable = Boolean(stream.getVideoTracks()[0].getCapabilities?.().torch); } catch {}
    $('torchButton').hidden = !torchAvailable;
    $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Stop scanning';
    $('cameraHint').textContent = "Center the code · Scan again whenever you're ready";
    say('Scanning automatically. Point at a QR code.');
    scheduleScan(activeSession);
  } catch (error) {
    if (activeSession !== session) return;
    stopCamera();
    const message = error.name === 'NotAllowedError' || error.name === 'SecurityError'
      ? 'Camera access was denied or blocked. Allow camera access for this site/app in browser settings, then tap Start scanning.'
      : error.name === 'NotFoundError'
        ? 'No camera was found on this device.'
        : error.name === 'NotReadableError'
          ? 'The camera is busy. Close other apps using it, then tap Start scanning.'
          : error.name === 'OverconstrainedError'
            ? 'The selected camera is not available. Tap Start scanning to retry.'
            : error.message || 'Camera could not start. Check permission and try Start scanning again.';
    say(message, true);
    $('cameraHint').textContent = message;
    $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Tap to enable camera';
  }
}

function scheduleScan(activeSession) {
  if (!scanning || activeSession !== session) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => scanFrame(activeSession));
  else requestAnimationFrame(() => scanFrame(activeSession));
}

async function scanFrame(activeSession) {
  if (!scanning || activeSession !== session || decoderFailed) return;
  const now = performance.now();
  if (detectorBusy) { scheduleScan(activeSession); return; }
  if (now - lastScanAt < LIVE_SCAN_INTERVAL_MS) { scheduleScan(activeSession); return; }
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
        if (value === lastDecodedValue && time - lastDecodedAt < 1200) {
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
      if (error.name === 'NotSupportedError' && detectorMode === 'native') {
        detector = fallbackDetector();
        detectorMode = 'jsqr';
        decoderFailed = false;
      } else if (error.message?.startsWith('The built-in QR decoder')) {
        // Leave the preview running and make the failure actionable instead of
        // shutting down the camera and forcing the user to reopen the app.
        decoderFailed = true;
        scanning = false;
        $('cameraButton').disabled = false;
        $('liveBadge').hidden = true;
        say(error.message, true);
        $('cameraHint').textContent = 'Camera preview is on · Tap Retry scanner';
        $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Retry scanner';
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
  try {
    detector = new BarcodeDetector({ formats: ['qr_code'] });
    detectorMode = 'native';
  } catch {
    detector = fallbackDetector();
    detectorMode = 'jsqr';
  }
} else {
  detector = fallbackDetector();
  detectorMode = 'jsqr';
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
renderHistory();
startCamera();
