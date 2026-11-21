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
let cameraRequest = null;
let session = 0;
let starting = false;
let readingImage = false;
let resumeOnVisible = document.hidden;
let navigating = false;
let navigationTimer = null;
let lastOpenedQR = history.state?.qrReturnValue || '';
const heldCodes = new Set(lastOpenedQR ? [lastOpenedQR] : []);
if (lastOpenedQR && Array.isArray(history.state?.qrHeldValues)) {
  for (const value of history.state.qrHeldValues) if (typeof value === 'string') heldCodes.add(value);
}
let showedRepeatLink = false;
let lastBlankFrame = null;
let blankDuration = 0;
let manuallyStopped = false;
let installPrompt = null;
let restartTimer = null;
let feedbackTimer = null;
let focusAnimation = null;
// Visual effects never schedule decoding or delay camera acquisition/navigation.
function setVisualState(state) {
  stage.setAttribute('data-state', state);
  stage.setAttribute('aria-busy', String(state === 'opening' || state === 'reading'));
  $('liveBadge').hidden = false;
  const labels = {
    opening: ['CONNECTING', 'Opening your camera', 'Keep the QR inside the frame'],
    scanning: ['LIVE SCAN', 'Ready for your next scan', 'Keep the QR inside the frame'],
    idle: ['PAUSED', 'Camera paused', 'Tap Start scanning to continue'],
    reading: ['IMAGE SCAN', 'Reading your image', 'Looking for a QR code'],
    detected: ['CODE DETECTED', 'Opening your link', 'Ready for your next scan'],
    error: ['CAMERA OFFLINE', 'Camera needs attention', 'Check the message below, then retry']
  };
  const [label, title, message] = labels[state];
  $('scanState').textContent = label;
  $('placeholderTitle').textContent = title;
  $('placeholderMessage').textContent = message;
}

function detectionFeedback() {
  clearTimeout(feedbackTimer);
  stage.setAttribute('data-feedback', 'detected');
  feedbackTimer = setTimeout(() => {
    stage.setAttribute('data-feedback', '');
    feedbackTimer = null;
  }, 650);
}

function focusFeedback(x = 0.5, y = 0.5) {
  const reticle = $('focusReticle');
  reticle.style.left = `${Math.max(0.08, Math.min(0.92, x)) * 100}%`;
  reticle.style.top = `${Math.max(0.08, Math.min(0.92, y)) * 100}%`;
  focusAnimation?.cancel();
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  focusAnimation = reticle.animate?.([
    { opacity: 0, transform: 'translate(-50%, -50%) scale(1.25)' },
    { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.2 },
    { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.65 },
    { opacity: 0, transform: 'translate(-50%, -50%) scale(0.95)' }
  ], { duration: 560, easing: 'ease-out' });
}
const historyKey = 'lector-qr-history-v1';
const scanner = QRScanner.create({
  video, stage, frame: $('scanFrame'),
  preferFallback: history.state?.qrUseFallback === true,
  isHeld: value => heldCodes.has(value),
  onTick: now => cameraControls?.tick(now),
  onStall: () => reconnectCamera(session, 'Camera preview stopped updating.'),
  onDetections(codes, now, wide) {
    if (!codes.length) {
      if (!heldCodes.size) return;
      // Count only decoded, fresh frames. Time spent away, a frozen preview
      // and a single missed decode cannot release a QR that is still in view.
      if (lastBlankFrame !== null) blankDuration += Math.min(now - lastBlankFrame, 250);
      lastBlankFrame = now;
      if (wide && blankDuration >= 800) {
        heldCodes.clear();
        if (lastOpenedQR) rememberOpenedQR('');
        say('Ready for the next QR.');
      }
      return;
    }
    lastBlankFrame = null;
    blankDuration = 0;
    const next = codes.find(code => typeof code.rawValue === 'string' && code.rawValue && !heldCodes.has(code.rawValue));
    if (next) {
      showResult(next.rawValue, true, codes);
    } else if (lastOpenedQR && !showedRepeatLink && codes.some(code => code.rawValue === lastOpenedQR)) {
      showedRepeatLink = true;
      displayResult(lastOpenedQR, safeUrl(lastOpenedQR), false);
      say('Ready for another QR. Move this one out of view to scan it again, or use Open link.');
    }
  },
  onError(error) {
    stopCamera();
    setVisualState('error');
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
  setVisualState('error');
  say(message, true);
  $('cameraHint').textContent = 'Camera unavailable · Check permissions or close other apps, then retry';
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Retry camera';
}

function reconnectCamera(activeSession, message) {
  if (activeSession !== session || (!scanning && !starting) || manuallyStopped || document.hidden || navigating || cameraRecoveryTimer !== null) return;
  if (cameraRecoveryAttempts >= 2) {
    showCameraFailure('The camera is still unavailable. Close other apps using it, then tap Retry camera.');
    return;
  }
  cameraRecoveryAttempts++;
  stopCamera();
  setVisualState('opening');
  say(message + ' Reconnecting…');
  $('cameraHint').textContent = 'Camera interrupted · Reconnecting automatically';
  $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Cancel retry';
  const delay = cameraRecoveryAttempts === 1 ? 500 : 1200;
  cameraRecoveryTimer = setTimeout(() => {
    cameraRecoveryTimer = null;
    if (!document.hidden && !manuallyStopped && !navigating) startCamera();
  }, delay);
}

function monitorCameraTrack(track, activeSession) {
  if (!track?.addEventListener) return;
  track.addEventListener('ended', () => {
    reconnectCamera(activeSession, 'Camera disconnected.');
  });
  track.addEventListener('mute', () => {
    if (activeSession !== session || !scanning || manuallyStopped) return;
    clearTimeout(cameraMuteTimer);
    cameraMuteTimer = setTimeout(() => {
      cameraMuteTimer = null;
      if (activeSession === session && track.muted) {
        reconnectCamera(activeSession, 'Camera signal was interrupted.');
      }
    }, 1400);
  });
  track.addEventListener('unmute', () => {
    if (activeSession !== session) return;
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
  $('emptyHistory').hidden = items.length > 0 || $('historyWrap').hidden;
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

function rememberOpenedQR(value) {
  lastOpenedQR = value;
  showedRepeatLink = false;
  // Tag this scanner entry so Back also works after the browser discards the
  // document. Adding a duplicate entry would require an extra Back to leave.
  try {
    const state = { ...history.state, qrReturnValue: value };
    if (scanner.mode !== 'native') state.qrUseFallback = true;
    if (value && heldCodes.size > 1) state.qrHeldValues = [...heldCodes];
    else delete state.qrHeldValues;
    history.replaceState(state, '');
  } catch {}
}

function finishNavigation() {
  clearTimeout(navigationTimer);
  navigationTimer = null;
  navigating = false;
}

function recoverLink(value, url) {
  finishNavigation();
  setVisualState('idle');
  startCamera();
  displayResult(value, url);
  say('Link did not open. Use Open link to retry, or scan another QR.');
}

function showResult(value, save = true, visible = []) {
  const url = safeUrl(value);
  if (save && navigating) return;
  if (save) {
    // Keep already handled neighbours while both labels are in the frame,
    // including across Back. A different single label can be acted on at once.
    for (const held of heldCodes) {
      if (!visible.some(code => code.rawValue === held)) heldCodes.delete(held);
    }
    heldCodes.add(value);
    detectionFeedback();
    const items = getHistory().filter(item => item.value !== value);
    items.unshift({ value, time: Date.now() });
    try { localStorage.setItem(historyKey, JSON.stringify(items.slice(0, 10))); } catch {}
    if (!url) renderHistory();
    try { navigator.vibrate?.(25); } catch {}
  }
  if (save && url) {
    rememberOpenedQR(value);
    navigating = true;
    stopCamera();
    try {
      window.location.assign(url);
      // Some browsers silently cancel a handoff. Keep a visible scanner usable.
      navigationTimer = setTimeout(() => {
        if (navigating && !document.hidden) recoverLink(value, url);
      }, 5000);
    } catch { recoverLink(value, url); }
    return;
  }
  if (save && lastOpenedQR) rememberOpenedQR('');
  displayResult(value, url, !save || !scanning);
  say('QR code detected.');
}

function displayResult(value, url, scroll = true) {
  $('resultValue').textContent = value;
  $('result').hidden = false;
  $('openLink').hidden = !url;
  if (url) $('openLink').href = url;
  if (scroll) $('result').scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

function stopCamera() {
  session++;
  lastBlankFrame = null;
  blankDuration = 0;
  starting = false;
  readingImage = false;
  scanning = false;
  cameraRequest?.abort();
  cameraRequest = null;
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
  clearTimeout(feedbackTimer);
  feedbackTimer = null;
  stage.setAttribute('data-feedback', '');
  focusAnimation?.cancel();
  focusAnimation = null;
  $('cameraButton').disabled = false;
  if (stream) stream.getTracks().forEach(track => {
    try { track.stop(); } catch {}
  });
  stream = null;
  video.srcObject = null;
  stage.classList.remove('active');
  setVisualState(navigating ? 'detected' : 'idle');
  $('focusButton').hidden = true;
  $('zoomControls').hidden = true;
  $('cameraPicker').hidden = true;
  $('cameraButton').innerHTML = '<span aria-hidden="true">◎</span> Start scanning';
  $('cameraHint').textContent = 'Camera ready · Scan again instantly';
}

async function startCamera(force = false) {
  if (force) {
    manuallyStopped = false;
    cameraRecoveryAttempts = 0;
  }
  if (manuallyStopped || starting || scanning || document.hidden || navigating || cameraRecoveryTimer !== null) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return showCameraFailure('Camera access requires a secure HTTPS page. Open the QR Reader website in Chrome or Edge.');
  }
  stopCamera();
  const activeSession = session;
  const request = new AbortController();
  cameraRequest = request;
  starting = true;
  setVisualState('opening');
  $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Cancel camera request';
  say('Requesting camera access…');
  try {
    const { stream: openedStream, devices } = await QRCamera.open({
      mediaDevices: navigator.mediaDevices, facingMode: 'environment', deviceId: selectedCameraId,
      signal: request.signal
    });
    if (activeSession !== session) { openedStream.getTracks().forEach(track => track.stop()); return; }
    stream = openedStream;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await QRCamera.play(video, request.signal);
    if (activeSession !== session) return;
    cameraRequest = null;
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
    setVisualState('scanning');
    const track = stream.getVideoTracks()[0];
    monitorCameraTrack(track, activeSession);
    renderCameraOptions(devices, track);
    $('cameraButton').innerHTML = '<span aria-hidden="true">◼</span> Stop scanning';
    updateCameraHint(track);
    say('Scanning automatically. Point at a QR code.');
    scanner.start(heldCodes.size > 0);
    registerUpdates();
    // Tuning runs alongside decoding, never holding up the first scan.
    cameraControls = QRCamera.createController(track, {
      isCurrent: () => activeSession === session, supported: cameraSupported,
      onChange: snapshot => updateCameraControls(track, snapshot)
    });
    cameraControls.ready.catch(() => {});
  } catch (error) {
    if (activeSession !== session) return;
    registerUpdates();
    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      reconnectCamera(activeSession, 'Camera is temporarily busy.');
      return;
    }
    stopCamera();
    setVisualState('error');
    const message = error.name === 'NotAllowedError' || error.name === 'SecurityError'
      ? 'Camera permission is blocked. In Chrome, open the site controls beside the address bar → Site settings → Camera → Allow. In Windows, enable Settings → Privacy & security → Camera. Then reload and tap Retry camera.'
      : error.name === 'NotFoundError'
        ? 'No usable rear camera was found. The front camera is not used for scanning.'
        : error.name === 'OverconstrainedError'
          ? 'The selected camera is not available. Tap Retry camera.'
          : error.message || 'Camera could not start. Tap Retry camera.';
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
  readingImage = true;
  setVisualState('reading');
  say('Reading the image…');
  try {
    const bitmap = await createImageBitmap(file);
    try {
      if (fileSession !== session) return;
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
  } finally {
    if (fileSession === session) {
      readingImage = false;
      if (!navigating) setVisualState('idle');
    }
  }
}

$('cameraButton').addEventListener('click', () => {
  if (starting || scanning || cameraRecoveryTimer !== null) {
    manuallyStopped = true;
    stopCamera();
    say('Camera stopped.');
  } else {
    finishNavigation();
    startCamera(true);
  }
});
$('focusButton').addEventListener('click', () => {
  if (!cameraControls) return;
  focusFeedback();
  cameraControls.refocus();
});
stage.addEventListener('pointerup', event => {
  if (!cameraControls) return;
  const rect = stage.getBoundingClientRect();
  const scale = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
  if (!scale) return;
  focusFeedback((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
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
  try { localStorage.removeItem(historyKey); }
  catch { say('Could not clear the saved history.', true); return; }
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
function suspendScanner() {
  resumeOnVisible ||= !manuallyStopped && (scanning || starting || navigating || readingImage ||
    cameraRecoveryTimer !== null || restartTimer !== null);
  clearTimeout(navigationTimer);
  navigationTimer = null;
  stopCamera();
}

function restoreScanner() {
  if (navigating) $('result').hidden = true;
  finishNavigation();
  selectedCameraId = '';
  resumeOnVisible = document.hidden && !manuallyStopped;
  if (document.hidden) return;
  renderHistory();
  if (!manuallyStopped) startCamera();
}

document.addEventListener('visibilitychange', () => {
  stage.classList.toggle('effects-paused', document.hidden);
  if (document.hidden) suspendScanner();
  else if (resumeOnVisible || navigating) restoreScanner();
});
window.addEventListener('popstate', event => {
  if (event.state?.qrReturnValue || event.state?.qrScanner || navigating || resumeOnVisible) restoreScanner();
});
window.addEventListener('pagehide', suspendScanner);
window.addEventListener('pageshow', event => {
  if (event?.persisted || resumeOnVisible || navigating) restoreScanner();
  else renderHistory();
});

// Ask for the camera before rendering optional history or checking for updates.
startCamera();

