const $ = id => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const status = $('status');
let stream = null;
let detector = null;
let detectorMode = 'none';
let decoderFailed = false;
let scanning = false;
let selectedCameraId = '';
let cameraControls = null;
let cameraSupported = {};
try { cameraSupported = navigator.mediaDevices?.getSupportedConstraints?.() || {}; } catch {}
// Re-evaluate the best rear camera every visit; legacy saved front/manual choices
// must not override automatic selection on this device.
try { localStorage.removeItem('pci-qr-camera-v1'); } catch {}
let cameraRecoveryAttempts = 0;
let cameraRecoveryTimer = null;
let cameraMuteTimer = null;
let cameraStableTimer = null;
let detectorErrorCount = 0;
let session = 0;
let starting = false;
let resumeOnVisible = false;
let navigating = false;
let manuallyStopped = false;
let installPrompt = null;
let lastScanAt = 0;
let scanFrameCount = 0;
let averageDecodeMs = 0;
let detectorBusy = false;
let lastDecodedValue = '';
let lastDecodedAt = 0;
let restartTimer = null;
const historyKey = 'lector-qr-history-v1';
const decoderUrl = './vendor/jsQR.js';
const NATIVE_SCAN_INTERVAL_MS = 33;
const FALLBACK_SCAN_INTERVAL_MS = 70;
const FALLBACK_MAX_DIMENSION = 960;
const scanCanvas = document.createElement('canvas');
const scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });

function fallbackDetector() {
  const canvas = scanCanvas;
  const context = scanContext;
  let frameCount = 0;
  let decoderReady = null;
  let worker = null;
  let requestId = 0;
  const pending = new Map();
  const failWorker = () => {
    worker?.terminate();
    worker = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('QR worker unavailable.'));
    }
    pending.clear();
  };
  try {
    if (typeof Worker === 'function') {
      worker = new Worker('./scan-worker.js?v=33');
      worker.onmessage = ({ data }) => {
        const request = pending.get(data.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.codes || []);
      };
      worker.onerror = event => { event.preventDefault?.(); failWorker(); };
    }
  } catch { failWorker(); }
  function loadDecoder() {
    if (window.jsQR) return Promise.resolve();
    if (decoderReady) return decoderReady;
    decoderReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = decoderUrl;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('The built-in QR decoder could not load. Reload PCI QR Reader and try again.'));
      document.head.append(script);
    });
    return decoderReady;
  }
  return {
    dispose: failWorker,
    get threaded() { return Boolean(worker); },
    async detect(source) {
      if (!context) throw new Error('The built-in QR decoder is unavailable.');
      const width = source.videoWidth || source.width;
      const height = source.videoHeight || source.height;
      if (!width || !height) return [];
      const isLiveVideo = source === video || source === canvas;
      const maxDimension = source === canvas ? Math.max(width, height) : isLiveVideo ? FALLBACK_MAX_DIMENSION : 1600;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      if (source !== canvas) context.drawImage(source, 0, 0, targetWidth, targetHeight);
      let pixels = context.getImageData(0, 0, targetWidth, targetHeight);
      // Most QR codes are normally oriented. Check inverted codes periodically to
      // keep routine frames fast without losing support for unusual labels.
      const inversionAttempts = !isLiveVideo || ++frameCount % 5 === 0 ? 'attemptBoth' : 'dontInvert';
      if (worker) {
        try {
          return await new Promise((resolve, reject) => {
            const id = ++requestId;
            const timer = setTimeout(failWorker, isLiveVideo ? 1800 : 5000);
            pending.set(id, { resolve, reject, timer });
            worker.postMessage({ id, width: targetWidth, height: targetHeight,
              buffer: pixels.data.buffer, inversionAttempts }, [pixels.data.buffer]);
          });
        } catch {
          failWorker();
          // The transferred buffer may be detached; reacquire pixels for the
          // local decoder. A worker failure does not disable camera scanning.
          pixels = context.getImageData(0, 0, targetWidth, targetHeight);
        }
      }
      await loadDecoder();
      if (!window.jsQR) throw new Error('The built-in QR decoder is unavailable.');
      const code = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts });
      return code ? [{ rawValue: code.data }] : [];
    }
  };
}

function captureScanRegion(wide = false, detailed = false) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const stageRect = stage.getBoundingClientRect();
  const frameRect = $('scanFrame').getBoundingClientRect();
  if (!scanContext || !width || !height || !stageRect.width || !stageRect.height || !frameRect.width) return video;

  const fitScale = Math.max(stageRect.width / width, stageRect.height / height);
  const centerX = width / 2 + (frameRect.left + frameRect.width / 2 - stageRect.left - stageRect.width / 2) / (fitScale);
  const centerY = height / 2 + (frameRect.top + frameRect.height / 2 - stageRect.top - stageRect.height / 2) / (fitScale);
  // Leave a quiet border around the QR and periodically inspect the whole visible
  // preview, so a large/off-center code is not permanently clipped by the guide.
  const sourceWidth = (wide ? stageRect.width : frameRect.width * 1.18) / fitScale;
  const sourceHeight = (wide ? stageRect.height : frameRect.height * 1.18) / fitScale;
  const sx = Math.max(0, Math.min(width - 1, centerX - sourceWidth / 2));
  const sy = Math.max(0, Math.min(height - 1, centerY - sourceHeight / 2));
  const sw = Math.max(1, Math.min(width - sx, sourceWidth));
  const sh = Math.max(1, Math.min(height - sy, sourceHeight));

  const fallbackLimit = detector?.threaded && averageDecodeMs < 140 ? 1280 : FALLBACK_MAX_DIMENSION;
  const maxDimension = detectorMode === 'native' ? 1600 : (detailed || wide) ? fallbackLimit : 768;
  const scale = Math.min(1, maxDimension / Math.max(sw, sh));
  const targetWidth = Math.max(1, Math.round(sw * scale));
  const targetHeight = Math.max(1, Math.round(sh * scale));
  if (scanCanvas.width !== targetWidth) scanCanvas.width = targetWidth;
  if (scanCanvas.height !== targetHeight) scanCanvas.height = targetHeight;
  scanContext.drawImage(video, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  return scanCanvas;
}

function renderCameraOptions(devices, track) {
  const settings = track.getSettings?.() || {};
  const rearDevices = devices.filter(device => device.deviceId && !QRCamera.isFront(device,
    device.deviceId === settings.deviceId ? settings : {}));
  const select = $('cameraSelect');
  select.replaceChildren(new Option('Automatic · Best rear camera', ''));
  for (const [index, device] of rearDevices.entries()) {
    if (device.deviceId) select.add(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
  }
  if (selectedCameraId && selectedCameraId !== settings.deviceId) selectedCameraId = '';
  select.value = selectedCameraId;
  $('cameraPicker').hidden = rearDevices.length < 2;
}

function updateCameraHint(track) {
  const settings = track.getSettings?.() || {};
  const details = [track.label || 'Camera'];
  if (settings.width && settings.height) details.push(`${settings.width} × ${settings.height}`);
  if (settings.focusMode === 'continuous') details.push('Autofocus');
  if (Number.isFinite(settings.zoom)) details.push(`${settings.zoom.toFixed(1)}×`);
  $('cameraHint').textContent = details.join(' · ');
  $('cameraHint').title = details.join(' · ');
}

function updateCameraControls(track, snapshot) {
  updateCameraHint(track);
  $('focusButton').hidden = !snapshot.canFocus;
  $('zoomControls').hidden = !snapshot.zoom;
  if (!snapshot.zoom) return;
  const slider = $('zoomRange');
  slider.min = snapshot.zoom.min;
  slider.max = snapshot.zoom.max;
  slider.step = snapshot.zoom.step > 0 ? snapshot.zoom.step : 0.1;
  const value = snapshot.settings.zoom;
  if (Number.isFinite(value)) {
    slider.value = value;
    $('zoomValue').textContent = `${value.toFixed(1)}×`;
  }
  $('autoZoomButton').setAttribute('aria-pressed', String(snapshot.automatic));
}

function showCameraFailure(message) {
  stopCamera();
  say(message, true);
  $('cameraHint').textContent = 'Camera unavailable · Check permissions or close other apps, then retry';
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Retry camera';
}

function handleUnexpectedCameraLoss(activeSession, message) {
  if (activeSession !== session || !scanning || manuallyStopped || document.hidden || navigating || cameraRecoveryTimer) return;
  if (cameraRecoveryAttempts >= 2) {
    showCameraFailure('The camera disconnected repeatedly. Close other apps using the camera, then tap Retry camera.');
    return;
  }
  cameraRecoveryAttempts++;
  stopCamera();
  say(message + ' Reconnecting…');
  $('cameraHint').textContent = 'Camera interrupted · Reconnecting automatically';
  const delay = 300 * cameraRecoveryAttempts;
  cameraRecoveryTimer = setTimeout(() => {
    cameraRecoveryTimer = null;
    if (!document.hidden && !manuallyStopped && !navigating) startCamera();
  }, delay);
}

function monitorCameraTrack(track, activeSession) {
  if (!track?.addEventListener) return;
  track.addEventListener('ended', () => {
    handleUnexpectedCameraLoss(activeSession, 'Camera disconnected.');
  });
  track.addEventListener('mute', () => {
    if (activeSession !== session || !scanning || manuallyStopped) return;
    clearTimeout(cameraMuteTimer);
    cameraMuteTimer = setTimeout(() => {
      cameraMuteTimer = null;
      if (activeSession === session && track.muted) {
        handleUnexpectedCameraLoss(activeSession, 'Camera signal was interrupted.');
      }
    }, 1400);
  });
  track.addEventListener('unmute', () => {
    clearTimeout(cameraMuteTimer);
    cameraMuteTimer = null;
  });
}

function say(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function getHistory() {
  try {
    const items = JSON.parse(localStorage.getItem(historyKey));
    return Array.isArray(items)
      ? items.filter(item => item && typeof item.value === 'string' && Number.isFinite(item.time))
      : [];
  } catch { return []; }
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
    try { navigator.vibrate?.(25); } catch {}
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
  cameraControls?.stop();
  cameraControls = null;
  clearTimeout(restartTimer);
  restartTimer = null;
  clearTimeout(cameraRecoveryTimer);
  cameraRecoveryTimer = null;
  clearTimeout(cameraMuteTimer);
  cameraMuteTimer = null;
  clearTimeout(cameraStableTimer);
  cameraStableTimer = null;
  $('cameraButton').disabled = false;
  if (stream) stream.getTracks().forEach(track => {
    try { track.stop(); } catch {}
  });
  stream = null;
  video.srcObject = null;
  stage.classList.remove('active');
  $('liveBadge').hidden = true;
  $('focusButton').hidden = true;
  $('zoomControls').hidden = true;
  $('cameraPicker').hidden = true;
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Start scanning';
  $('cameraHint').textContent = 'Camera ready · Scan again instantly';
}

async function startCamera(force = false) {
  if (force) {
    manuallyStopped = false;
    if (decoderFailed && detectorMode === 'jsqr') {
      detector?.dispose?.();
      decoderFailed = false;
      detector = fallbackDetector();
    }
  }
  if (manuallyStopped || starting || scanning || document.hidden || navigating) return;
  if (!detector) return showCameraFailure('This browser does not support QR scanning. Try an up-to-date version of Chrome or Edge.');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return showCameraFailure('Camera access requires a secure HTTPS page. Open the QR Reader website in Chrome or Edge.');
  }
  stopCamera();
  const activeSession = session;
  starting = true;
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Opening camera…';
  $('cameraButton').disabled = true;
  say('Requesting camera access…');
  try {
    const { stream: openedStream, devices } = await QRCamera.open({
      mediaDevices: navigator.mediaDevices, facingMode: 'environment', deviceId: selectedCameraId,
      isCurrent: () => activeSession === session
    });
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
    cameraRecoveryTimer = null;
    clearTimeout(cameraStableTimer);
    cameraStableTimer = setTimeout(() => {
      cameraRecoveryAttempts = 0;
      cameraStableTimer = null;
    }, 8000);
    detectorErrorCount = 0;
    lastScanAt = 0;
    scanFrameCount = 0;
    averageDecodeMs = 0;
    $('cameraButton').disabled = false;
    stage.classList.add('active');
    $('liveBadge').hidden = false;
    const track = stream.getVideoTracks()[0];
    monitorCameraTrack(track, activeSession);
    renderCameraOptions(devices, track);
    $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Stop scanning';
    updateCameraHint(track);
    say('Scanning automatically. Point at a QR code.');
    scheduleScan(activeSession);
    // Tuning runs alongside decoding, never holding up the first scan.
    cameraControls = QRCamera.createController(track, {
      isCurrent: () => activeSession === session, supported: cameraSupported,
      onChange: snapshot => updateCameraControls(track, snapshot)
    });
    cameraControls.ready.catch(() => {});
  } catch (error) {
    if (activeSession !== session) return;
    stopCamera();
    const message = error.name === 'NotAllowedError' || error.name === 'SecurityError'
      ? 'Camera permission is blocked. In Chrome, open the site controls beside the address bar → Site settings → Camera → Allow. In Windows, enable Settings → Privacy & security → Camera. Then reload and tap Retry camera.'
      : error.name === 'NotFoundError'
        ? 'No usable rear camera was found. The front camera is not used for scanning.'
        : error.name === 'NotReadableError'
          ? 'The camera is busy. Close other apps using it, then tap Start scanning.'
          : error.name === 'OverconstrainedError'
            ? 'The selected camera is not available. Tap Start scanning to retry.'
            : error.message || 'Camera could not start. Check permission and try Start scanning again.';
    say(message, true);
    $('cameraHint').textContent = message;
    $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Retry camera';
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
  cameraControls?.tick(now);
  if (detectorBusy) return;
  const scanInterval = detectorMode === 'native' ? NATIVE_SCAN_INTERVAL_MS : FALLBACK_SCAN_INTERVAL_MS;
  if (now - lastScanAt < scanInterval) { scheduleScan(activeSession); return; }
  if (video.readyState >= 2) {
    detectorBusy = true;
    lastScanAt = now;
    try {
      const activeDetector = detector;
      const frameNumber = ++scanFrameCount;
      const codes = await activeDetector.detect(captureScanRegion(frameNumber % 6 === 0, frameNumber % 5 === 0));
      const decodeMs = performance.now() - now;
      if (activeSession === session) averageDecodeMs = averageDecodeMs ? averageDecodeMs * 0.8 + decodeMs * 0.2 : decodeMs;
      detectorBusy = false;
      detectorErrorCount = 0;
      if (!scanning || activeSession !== session) {
        // A frame from the prior camera can finish after a quick restart. Re-arm
        // scanning for the current session so one stale decode cannot stall it.
        if (scanning && !decoderFailed) scheduleScan(session);
        return;
      }
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
        if (!safeUrl(value)) scheduleCameraRestart(350);
        return;
      }
    } catch (error) {
      detectorBusy = false;
      if (activeSession !== session) {
        if (scanning && !decoderFailed) scheduleScan(session);
        return;
      }
      detectorErrorCount++;
      if (detectorMode === 'native' &&
          (error.name === 'NotSupportedError' || error.name === 'TypeError' || detectorErrorCount >= 2)) {
        detector = fallbackDetector();
        detectorMode = 'jsqr';
        detectorErrorCount = 0;
        decoderFailed = false;
      } else if (error.message?.startsWith('The built-in QR decoder') || (detectorMode === 'jsqr' && detectorErrorCount >= 3)) {
        decoderFailed = true;
        scanning = false;
        $('cameraButton').disabled = false;
        $('liveBadge').hidden = true;
        const message = error.message?.startsWith('The built-in QR decoder')
          ? error.message
          : 'QR scanning paused after repeated errors. Tap Retry scanner.';
        say(message, true);
        $('cameraHint').textContent = 'Camera preview is on · Tap Retry scanner';
        $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Retry scanner';
      }
    }
  }
  scheduleScan(activeSession);
}

function scheduleCameraRestart(delay = 350) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!document.hidden && !manuallyStopped && !navigating) startCamera();
  }, delay);
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
        if (!safeUrl(codes[0].rawValue)) scheduleCameraRestart(350);
      } else {
        say('No QR code was found in the image.', true);
        scheduleCameraRestart(350);
      }
    } finally { bitmap.close(); }
  } catch {
    say('Could not read the image. Choose a valid image file.', true);
    scheduleCameraRestart(350);
  }
}

$('cameraButton').addEventListener('click', () => {
  if (scanning) {
    manuallyStopped = true;
    stopCamera();
    say('Camera stopped.');
  } else startCamera(true);
});
$('focusButton').addEventListener('click', () => cameraControls?.refocus());
stage.addEventListener('pointerup', event => {
  if (!cameraControls) return;
  const rect = stage.getBoundingClientRect();
  const scale = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
  if (!scale) return;
  cameraControls.refocus({
    x: 0.5 + (event.clientX - rect.left - rect.width / 2) / (scale * video.videoWidth),
    y: 0.5 + (event.clientY - rect.top - rect.height / 2) / (scale * video.videoHeight)
  });
});
$('zoomRange').addEventListener('input', event => cameraControls?.setZoom(Number(event.target.value)));
$('autoZoomButton').addEventListener('click', () => cameraControls?.setAutoZoom());
$('cameraSelect').addEventListener('change', event => {
  selectedCameraId = event.target.value;
  stopCamera();
  startCamera(true);
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
    selectedCameraId = '';
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
  selectedCameraId = '';
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
if ('serviceWorker' in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    const refreshKey = 'qr-reader-worker-v33';
    if (sessionStorage.getItem(refreshKey)) return;
    sessionStorage.setItem(refreshKey, '1');
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(registration => registration.update())
    .catch(() => {});
}
renderHistory();
startCamera();
