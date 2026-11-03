const $ = id => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const status = $('status');
let stream = null;
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
let session = 0;
let starting = false;
let resumeOnVisible = false;
let navigating = false;
let manuallyStopped = false;
let installPrompt = null;
let lastDecodedValue = '';
let lastDecodedAt = 0;
let restartTimer = null;
const historyKey = 'lector-qr-history-v1';
const scanner = QRScanner.create({
  video, stage, frame: $('scanFrame'),
  onTick: now => cameraControls?.tick(now),
  onResult(value) {
    const time = Date.now();
    if (value === lastDecodedValue && time - lastDecodedAt < 1200) return;
    lastDecodedValue = value;
    lastDecodedAt = time;
    showResult(value);
    // Text codes keep the already focused camera running for the next scan.
  },
  onError(error) {
    stopCamera();
    say(error.message || 'QR scanning paused. Tap Retry scanner.', true);
    $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Retry scanner';
  }
});
let workerRegistrationStarted = false;
function registerUpdates() {
  if (workerRegistrationStarted || !('serviceWorker' in navigator)) return;
  workerRegistrationStarted = true;
  // Updates run after camera acquisition, with no reload in an active scan.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(registration => registration.update()).catch(() => {});
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
  if ($('historyWrap').hidden) return;
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
    if (!url) renderHistory();
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
  scanner.stop();
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
  }
  if (manuallyStopped || starting || scanning || document.hidden || navigating) return;
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
    $('cameraButton').disabled = false;
    stage.classList.add('active');
    $('liveBadge').hidden = false;
    const track = stream.getVideoTracks()[0];
    monitorCameraTrack(track, activeSession);
    renderCameraOptions(devices, track);
    $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Stop scanning';
    updateCameraHint(track);
    say('Scanning automatically. Point at a QR code.');
    scanner.start();
    registerUpdates();
    // Tuning runs alongside decoding, never holding up the first scan.
    cameraControls = QRCamera.createController(track, {
      isCurrent: () => activeSession === session, supported: cameraSupported,
      onChange: snapshot => updateCameraControls(track, snapshot)
    });
    cameraControls.ready.catch(() => {});
  } catch (error) {
    if (activeSession !== session) return;
    stopCamera();
    registerUpdates();
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

function scheduleCameraRestart(delay = 350) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!document.hidden && !manuallyStopped && !navigating) startCamera();
  }, delay);
}

async function readFile(file) {
  if (!file) return;
  stopCamera();
  const fileSession = session;
  say('Reading the image…');
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const codes = await scanner.read(bitmap);
      if (fileSession !== session) return;
      if (codes.length) {
        showResult(codes[0].rawValue);
        if (!safeUrl(codes[0].rawValue)) scheduleCameraRestart(350);
      } else {
        say('No QR code was found in the image.', true);
        scheduleCameraRestart(350);
      }
    } finally { bitmap.close(); }
  } catch {
    if (fileSession !== session) return;
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
$('uploadButton').addEventListener('click', () => $('fileInput').click());
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
    renderHistory();
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
  if (!document.hidden && !manuallyStopped) { renderHistory(); startCamera(); }
});

// Ask for the camera before rendering optional history or checking for updates.
startCamera();
