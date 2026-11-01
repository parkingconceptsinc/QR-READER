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
let rearCameraDeviceId = null;
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
let detectorBusy = false;
let lastDecodedValue = '';
let lastDecodedAt = 0;
let restartTimer = null;
const historyKey = 'lector-qr-history-v1';
const decoderUrl = './vendor/jsQR.js';
const NATIVE_SCAN_INTERVAL_MS = 33;
const FALLBACK_SCAN_INTERVAL_MS = 70;
const FALLBACK_MAX_DIMENSION = 768;
const SCAN_FRAME_DIMENSION = 768;
const scanCanvas = document.createElement('canvas');
const scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });
const PREFERRED_CAMERA_ZOOM = 2;

function fallbackDetector() {
  const canvas = scanCanvas;
  const context = scanContext;
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
      const isLiveVideo = source === video || source === canvas;
      const maxDimension = isLiveVideo ? FALLBACK_MAX_DIMENSION : 1600;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      if (source !== canvas) context.drawImage(source, 0, 0, targetWidth, targetHeight);
      const pixels = context.getImageData(0, 0, targetWidth, targetHeight);
      // Most QR codes are normally oriented. Check inverted codes periodically to
      // keep routine frames fast without losing support for unusual labels.
      const inversionAttempts = !isLiveVideo || ++frameCount % 5 === 0 ? 'attemptBoth' : 'dontInvert';
      const code = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts });
      return code ? [{ rawValue: code.data }] : [];
    }
  };
}

async function applyPreferredCameraSettings(track) {
  if (facingMode !== 'environment') return false;
  try {
    const capabilities = track.getCapabilities?.() || {};
    const current = track.getConstraints?.() || {};
    const preferred = [];
    const range = capabilities.zoom;
    if (range && Number.isFinite(range.max)) {
      const minimum = Number.isFinite(range.min) ? range.min : 1;
      const target = Math.min(range.max, Math.max(minimum, PREFERRED_CAMERA_ZOOM));
      if (target > minimum + 0.05) preferred.push({ zoom: target });
    }
    for (const [name, mode] of [
      ['focusMode', 'continuous'],
      ['exposureMode', 'continuous'],
      ['whiteBalanceMode', 'continuous']
    ]) {
      if (Array.isArray(capabilities[name]) && capabilities[name].includes(mode)) preferred.push({ [name]: mode });
    }
    const supportedNames = new Set(['zoom', 'focusMode', 'exposureMode', 'whiteBalanceMode']);
    const advanced = (Array.isArray(current.advanced) ? current.advanced : [])
      .filter(item => !Object.keys(item).some(name => supportedNames.has(name)));
    if (preferred.length) await track.applyConstraints({ ...current, advanced: [...advanced, ...preferred] });
    const actualZoom = track.getSettings?.().zoom;
    return Number.isFinite(actualZoom) ? actualZoom > 1.05 : preferred.some(item => item.zoom);
  } catch { return false; }
}

function captureScanRegion() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const stageRect = stage.getBoundingClientRect();
  const frameRect = $('scanFrame').getBoundingClientRect();
  if (!scanContext || !width || !height || !stageRect.width || !stageRect.height || !frameRect.width) return video;

  const fitScale = Math.max(stageRect.width / width, stageRect.height / height);
  const softwareZoom = Number(video.dataset.softwareZoom || 1);
  const centerX = width / 2 + (frameRect.left + frameRect.width / 2 - stageRect.left - stageRect.width / 2) / (fitScale * softwareZoom);
  const centerY = height / 2 + (frameRect.top + frameRect.height / 2 - stageRect.top - stageRect.height / 2) / (fitScale * softwareZoom);
  const sourceWidth = frameRect.width / (fitScale * softwareZoom);
  const sourceHeight = frameRect.height / (fitScale * softwareZoom);
  const sx = Math.max(0, Math.min(width - 1, centerX - sourceWidth / 2));
  const sy = Math.max(0, Math.min(height - 1, centerY - sourceHeight / 2));
  const sw = Math.max(1, Math.min(width - sx, sourceWidth));
  const sh = Math.max(1, Math.min(height - sy, sourceHeight));

  scanCanvas.width = SCAN_FRAME_DIMENSION;
  scanCanvas.height = SCAN_FRAME_DIMENSION;
  scanContext.drawImage(video, sx, sy, sw, sh, 0, 0, SCAN_FRAME_DIMENSION, SCAN_FRAME_DIMENSION);
  return scanCanvas;
}

function scoreRearCamera(device) {
  const label = (device.label || '').toLowerCase();
  if (!label || /front|user|selfie|facetime|frontal|delantera/.test(label)) return -Infinity;
  if (!/back|rear|environment|trasera|posterior/.test(label)) return -Infinity;
  let score = 100;
  if (/ultra.?wide|ultrawide|0[.,]5x|macro|depth|bokeh|telephoto|tele\b|[23]x/.test(label)) score -= 200;
  // Prefer the main rear module: it is usually the clearest lens and most likely
  // to expose the phone's LED torch to the browser.
  if (/main|primary|standard|normal|wide\b/.test(label)) score += 50;
  if (/camera\s*0|(?:^|\W)0(?:\W|$)/.test(label)) score += 1;
  return score;
}

async function findBestRearCamera(currentDeviceId) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices
      .filter(device => device.kind === 'videoinput')
      .map(device => ({ device, score: scoreRearCamera(device) }))
      .filter(entry => Number.isFinite(entry.score) && entry.score >= 100)
      .sort((a, b) => b.score - a.score);
    return cameras[0]?.device.deviceId || currentDeviceId || null;
  } catch { return currentDeviceId || null; }
}

async function applyTorch(track, on) {
  let capabilities;
  try { capabilities = track.getCapabilities?.(); } catch {}
  if (capabilities?.torch === false) {
    const error = new Error('This camera does not expose flashlight control to the browser.');
    error.name = 'TorchUnavailableError';
    throw error;
  }

  // The torch is an advanced MediaTrack constraint. Android Chrome does not
  // grant a separate flash permission; it is controlled by the active camera
  // permission and this user-initiated switch.
  const current = track.getConstraints?.() || {};
  const advanced = (Array.isArray(current.advanced) ? current.advanced : [])
    .filter(item => !Object.prototype.hasOwnProperty.call(item, 'torch'));
  await track.applyConstraints({ ...current, advanced: [...advanced, { torch: on }] });

  let state;
  try { state = track.getSettings?.().torch; } catch {}
  if (state === on || (state === undefined && capabilities?.torch !== false)) return;
  const error = new Error('The camera did not confirm the flashlight state.');
  error.name = 'TorchUnavailableError';
  throw error;
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
  clearTimeout(restartTimer);
  restartTimer = null;
  clearTimeout(cameraRecoveryTimer);
  cameraRecoveryTimer = null;
  clearTimeout(cameraMuteTimer);
  cameraMuteTimer = null;
  clearTimeout(cameraStableTimer);
  cameraStableTimer = null;
  $('cameraButton').disabled = false;
  $('torchButton').classList.remove('on');
  $('torchButton').setAttribute('aria-label', 'Turn flashlight on');
  $('torchButton').setAttribute('aria-pressed', 'false');
  if (stream) stream.getTracks().forEach(track => {
    try { track.stop(); } catch {}
  });
  stream = null;
  video.srcObject = null;
  video.style.transform = '';
  delete video.dataset.softwareZoom;
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
    // Prefer the rear camera without requiring an exact match; strict constraints can
    // reject valid Android camera devices and leave the preview blank.
    const videoConstraints = {
      ...(facingMode === 'environment' && rearCameraDeviceId
        ? { deviceId: { exact: rearCameraDeviceId } }
        : { facingMode: { ideal: facingMode } }),
      // Prefer the primary detailed rear lens and request zoom at startup.
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
      zoom: { ideal: PREFERRED_CAMERA_ZOOM }
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
    if (facingMode === 'environment') {
      const initialTrack = openedStream.getVideoTracks()[0];
      const currentId = initialTrack?.getSettings?.().deviceId || null;
      const preferredId = await findBestRearCamera(currentId);
      if (preferredId && preferredId !== currentId) {
        // Release the first camera before opening another rear lens; mobile browsers
        // often refuse two simultaneous streams from the same camera module.
        openedStream.getTracks().forEach(track => track.stop());
        try {
          openedStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { ...videoConstraints, deviceId: { exact: preferredId } }
          });
          rearCameraDeviceId = preferredId;
        } catch {
          // Reopen the browser-selected rear camera if the preferred labeled lens fails.
          openedStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { ...videoConstraints, facingMode: { ideal: 'environment' } }
          });
          rearCameraDeviceId = openedStream.getVideoTracks()[0]?.getSettings?.().deviceId || currentId;
        }
      } else {
        rearCameraDeviceId = preferredId || currentId;
      }
      if (activeSession !== session) { openedStream.getTracks().forEach(track => track.stop()); return; }
    }
    stream = openedStream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await video.play();
    if (activeSession !== session) return;
    // Keep continuous autofocus/exposure and hardware zoom when supported.
    const hardwareZoomApplied = await applyPreferredCameraSettings(stream.getVideoTracks()[0]);
    const softwareZoom = hardwareZoomApplied ? 1 : 1.3;
    video.dataset.softwareZoom = String(softwareZoom);
    video.style.transform = 'scale(' + softwareZoom + ')';
    starting = false;
    scanning = true;
    cameraRecoveryTimer = null;
    clearTimeout(cameraStableTimer);
    cameraStableTimer = setTimeout(() => {
      cameraRecoveryAttempts = 0;
      cameraStableTimer = null;
    }, 8000);
    detectorErrorCount = 0;
    $('cameraButton').disabled = false;
    stage.classList.add('active');
    $('liveBadge').hidden = false;
    $('switchButton').hidden = false;
    // Keep the flashlight control available on rear cameras. Some mobile browsers
    // support the torch constraint but omit it from getCapabilities().
    $('torchButton').hidden = facingMode !== 'environment';
    monitorCameraTrack(stream.getVideoTracks()[0], activeSession);
    $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Stop scanning';
    $('cameraHint').textContent = "Center the code · Tap ☼ for flashlight (uses Camera permission)";
    say('Scanning automatically. Point at a QR code.');
    scheduleScan(activeSession);
  } catch (error) {
    if (activeSession !== session) return;
    stopCamera();
    const message = error.name === 'NotAllowedError' || error.name === 'SecurityError'
      ? 'Camera permission is blocked. In Chrome, open the site controls beside the address bar → Site settings → Camera → Allow. In Windows, enable Settings → Privacy & security → Camera. Then reload and tap Retry camera.'
      : error.name === 'NotFoundError'
        ? 'No camera was found on this device.'
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
  if (detectorBusy) return;
  const scanInterval = detectorMode === 'native' ? NATIVE_SCAN_INTERVAL_MS : FALLBACK_SCAN_INTERVAL_MS;
  if (now - lastScanAt < scanInterval) { scheduleScan(activeSession); return; }
  if (video.readyState >= 2) {
    detectorBusy = true;
    lastScanAt = now;
    try {
      const activeDetector = detector;
      const codes = await activeDetector.detect(captureScanRegion());
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
$('switchButton').addEventListener('click', () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  stopCamera();
  startCamera();
});
$('torchButton').addEventListener('click', async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track || facingMode !== 'environment' || $('torchButton').disabled) return;
  const on = !$('torchButton').classList.contains('on');
  $('torchButton').disabled = true;
  try {
    await applyTorch(track, on);
    $('torchButton').classList.toggle('on', on);
    $('torchButton').setAttribute('aria-label', on ? 'Turn flashlight off' : 'Turn flashlight on');
    $('torchButton').setAttribute('aria-pressed', String(on));
    say(on ? 'Flashlight on.' : 'Flashlight off.');
  } catch (error) {
    const message = error?.name === 'TorchUnavailableError' || error?.name === 'OverconstrainedError' || error?.name === 'NotSupportedError'
      ? 'No separate flash permission exists in Android. This camera did not expose its flashlight to the browser. Keep Camera allowed in site settings and try the main rear camera in Chrome.'
      : 'Flashlight could not turn on. Keep Camera allowed in site settings and try again.';
    say(message, true);
    $('cameraHint').textContent = message;
  } finally {
    $('torchButton').disabled = false;
  }
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
if ('serviceWorker' in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    const refreshKey = 'qr-reader-worker-v21';
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
