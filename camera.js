/* Camera choice is a best effort: browsers do not expose sensor quality or every lens. */
globalThis.QRCamera = (() => {
  const rear = /\b(back|rear|environment|trasera|traseira|arrière|rück)\b/i;
  const front = /\b(front|user|facetime|selfie|frontal|avant)\b/i;
  const auxiliary = /ultra[\s_-]*wide|ultra[\s_-]*grand|tele(photo)?|macro|depth|infrared|\b(ir|tof)\b|0[.,]5\s*[x×]/i;

  function score(device, facingMode, currentSettings = {}) {
    const label = device.label || '';
    let capabilities = {};
    try { capabilities = device.getCapabilities?.() || {}; } catch {}
    const modes = capabilities.facingMode || [];
    const facing = (device.deviceId && device.deviceId === currentSettings.deviceId && currentSettings.facingMode) ||
      (modes.includes('environment') ? 'environment' : modes.includes('user') ? 'user' : '');
    const isFront = front.test(label) || facing === 'user';
    const isRear = !isFront && (rear.test(label) || facing === 'environment');
    if (facingMode === 'user') return isFront ? 100 : isRear ? -1000 : 0;
    if (isFront) return -1000;
    // Auxiliary/virtual lenses must never outrank an identified primary rear lens.
    if (auxiliary.test(label)) return isRear ? 10 : -10;
    let value = isRear ? 100 : 0;
    if (/\b(main|primary|principal|standard)\b|\b1\s*[x×]/i.test(label)) value += 60;
    else if (/\bwide\b|grand[\s-]*angle/i.test(label)) value += 40;
    if (/\b(dual|triple|logical|virtual)\b/i.test(label)) value -= 25;
    // InputDeviceInfo can expose capabilities without opening another camera.
    // Prefer autofocus and usable video detail when generic labels tie. Resolution
    // alone cannot identify sensor quality, so keep its contribution small/bounded.
    if (capabilities.focusMode?.includes('continuous')) value += 30;
    const detail = Math.max(capabilities.width?.max || 0, capabilities.height?.max || 0);
    if (detail >= 1920) value += Math.min(8, detail / 480);
    else if (detail && detail < 1280) value -= 10;
    return value;
  }

  function choose(devices, facingMode, settings = {}) {
    const ranked = devices.filter(device => device.kind === 'videoinput' && device.deviceId)
      .map(device => ({ device, score: score(device, facingMode, settings) }))
      .sort((a, b) => b.score - a.score);
    // With anonymous labels, trust the browser's facingMode choice, not list order.
    return ranked[0]?.score > 0 ? ranked[0].device : null;
  }

  async function list(mediaDevices) {
    try { return (await mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput'); }
    catch { return []; }
  }

  function close(stream) {
    stream?.getTracks().forEach(track => track.stop());
  }

  async function open({ mediaDevices, facingMode, deviceId = '', isCurrent = () => true }) {
    let opened = null;
    const attemptedRearIds = new Set();
    const check = () => {
      if (isCurrent()) return;
      close(opened);
      throw new DOMException('Camera request cancelled.', 'AbortError');
    };
    async function acquire(id = '') {
      if (id) attemptedRearIds.add(id);
      const identity = id ? { deviceId: { exact: id } } : { facingMode: { exact: facingMode } };
      // Ideal values request detail without rejecting a camera that can only
      // deliver less. A 30 fps preference leaves exposure/low-light adaptation free.
      const quality = { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
      const profiles = [
        { ...identity, ...quality },
        identity
      ];
      if (id) profiles.push({ facingMode: { ideal: facingMode }, ...quality }, { facingMode: { ideal: facingMode } });
      profiles.push(true);
      for (let index = 0; index < profiles.length; index++) {
        check();
        try {
          opened = await mediaDevices.getUserMedia({ audio: false, video: profiles[index] });
          check();
          const track = opened.getVideoTracks()[0];
          const settings = track?.getSettings?.() || {};
          if (facingMode === 'environment' && isFront({ label: track?.label }, settings)) {
            close(opened);
            opened = null;
            // Some browsers reveal lens IDs only after granting the first request
            // and may ignore facingMode. Recover by explicit rear ID before failing.
            const exposed = await list(mediaDevices);
            check();
            const alternative = choose(exposed.filter(device => !attemptedRearIds.has(device.deviceId)), facingMode);
            if (alternative && !isFront(alternative)) return acquire(alternative.deviceId);
            throw new DOMException('A rear camera is required. The front camera will not be used.', 'NotFoundError');
          }
          return opened;
        } catch (error) {
          const retry = ['OverconstrainedError', 'NotFoundError'].includes(error.name) ||
            (id && error.name === 'NotReadableError');
          if (!retry || index === profiles.length - 1) throw error;
        }
      }
    }
    try {
      let devices = await list(mediaDevices);
      check();
      if (facingMode === 'environment' && devices.length && devices.every(device => isFront(device))) {
        throw new DOMException('No rear camera was found.', 'NotFoundError');
      }
      const selected = devices.find(device => device.deviceId === deviceId);
      if (facingMode === 'environment' && selected && isFront(selected)) deviceId = '';
      const preferred = deviceId || choose(devices, facingMode)?.deviceId;
      await acquire(preferred);
      devices = await list(mediaDevices);
      check();
      const track = opened.getVideoTracks()[0];
      const settings = track?.getSettings?.() || {};
      const current = devices.find(device => device.deviceId === settings.deviceId) ||
        { deviceId: settings.deviceId, label: track?.label || '' };
      const best = choose(devices, facingMode, settings);
      // Permission can reveal the lens names only after the first camera opens.
      // Switch once, never probe every lens or keep two cameras open on mobile.
      if (!deviceId && best && best.deviceId !== settings.deviceId &&
          score(best, facingMode, settings) > score(current, facingMode, settings)) {
        close(opened);
        opened = null;
        await acquire(best.deviceId);
      }
      check();
      return { stream: opened, devices };
    } catch (error) {
      close(opened);
      throw error;
    }
  }

  function read(target, method) {
    try { return target?.[method]?.() || {}; } catch { return {}; }
  }

  function isFront(device, settings = {}) {
    const modes = read(device, 'getCapabilities').facingMode || [];
    return Boolean(settings.facingMode === 'user' || front.test(device.label || '') ||
      modes.includes('user') && !modes.includes('environment'));
  }

  function zoomValue(value, range) {
    const clamped = Math.min(range.max, Math.max(range.min, value));
    const step = range.step > 0 ? range.step : 0.1;
    return Math.min(range.max, Math.max(range.min,
      Number((range.min + Math.round((clamped - range.min) / step) * step).toFixed(6))));
  }

  function autoZoom(elapsed, range) {
    const base = zoomValue(1, range);
    const steps = [1, 1.35, 1.7, 1];
    // Revisit the wide view regularly. Extreme zoom can crop a QR or magnify shake.
    return zoomValue(Math.min(base * 2, base * steps[Math.floor(Math.max(0, elapsed) / 1500) % steps.length]), range);
  }

  function createController(track, { isCurrent = () => true, onChange = () => {}, supported = {} } = {}) {
    const capabilities = read(track, 'getCapabilities');
    let base = { ...read(track, 'getConstraints') };
    let image = Object.assign({}, ...(base.advanced || []));
    delete base.advanced;
    let stopped = false;
    let readyDone = false;
    let queue = Promise.resolve();
    let automatic = true;
    let zoomEpoch = null;
    let lastZoom = null;
    let zoomBusy = false;
    let manualZoomJob = null;
    let desiredManualZoom = null;
    let lastRefreshAt = -Infinity;
    const range = capabilities.zoom;
    let canZoom = Boolean(range && Number.isFinite(range.min) && Number.isFinite(range.max) &&
      range.min > 0 && range.max > range.min && Number.isFinite(read(track, 'getSettings').zoom));
    const focusMode = capabilities.focusMode?.includes('continuous') ? 'continuous'
      : capabilities.focusMode?.includes('single-shot') ? 'single-shot' : null;
    const active = () => !stopped && isCurrent() && track.readyState !== 'ended';
    const snapshot = () => ({ settings: read(track, 'getSettings'), automatic,
      canFocus: Boolean(focusMode || supported.pointsOfInterest),
      zoom: canZoom ? { ...range } : null });
    const changed = () => { if (active()) onChange(snapshot()); };

    function apply(patch, advanced = true) {
      const job = queue.then(async () => {
        if (!active() || !track.applyConstraints) return false;
        const nextBase = advanced ? base : { ...base, ...patch };
        const nextImage = advanced ? { ...image, ...patch } : image;
        try {
          await track.applyConstraints({ ...nextBase,
            ...(Object.keys(nextImage).length ? { advanced: [{ ...nextImage }] } : {}) });
          base = nextBase;
          image = nextImage;
          changed();
          return true;
        } catch { return false; }
      });
      queue = job.catch(() => false);
      return job;
    }

    async function applyZoom(value) {
      if (!canZoom || !active()) return false;
      const target = zoomValue(value, range);
      if (target === lastZoom) return true;
      const success = await apply({ zoom: target });
      if (success) lastZoom = target;
      else canZoom = false; // Denied/unsupported zoom never disables autofocus or scanning.
      changed();
      return success;
    }

    async function refocus(point = { x: 0.5, y: 0.5 }) {
      if (supported.pointsOfInterest && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        await apply({ pointsOfInterest: [{ x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) }] });
      }
      if (focusMode) return apply({ focusMode });
      return false;
    }

    const ready = (async () => {
      if (focusMode) await apply({ focusMode });
      for (const property of ['exposureMode', 'whiteBalanceMode']) {
        if (capabilities[property]?.includes('continuous')) await apply({ [property]: 'continuous' });
      }
      if (supported.pointsOfInterest) await apply({ pointsOfInterest: [{ x: 0.5, y: 0.5 }] });
      const settings = read(track, 'getSettings');
      if (Number.isFinite(capabilities.width?.max) && Number.isFinite(capabilities.height?.max)) {
        const portrait = settings.height > settings.width;
        const width = Math.min(capabilities.width.max, portrait ? 2160 : 3840);
        const height = Math.min(capabilities.height.max, portrait ? 3840 : 2160);
        if (width > 0 && height > 0 && (width > (settings.width || 0) || height > (settings.height || 0))) {
          await apply({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } }, false);
        }
      }
      if (capabilities.resizeMode?.includes('none')) await apply({ resizeMode: { ideal: 'none' } }, false);
      if (canZoom && automatic) await applyZoom(zoomValue(1, range));
      readyDone = true;
      changed();
    })();

    return {
      ready, snapshot, refocus,
      setZoom(value) {
        if (!Number.isFinite(value)) return Promise.resolve(false);
        automatic = false;
        desiredManualZoom = value;
        if (!manualZoomJob) {
          manualZoomJob = (async () => {
            let result = false;
            while (desiredManualZoom !== null && active() && !automatic) {
              const next = desiredManualZoom;
              desiredManualZoom = null;
              result = await applyZoom(next);
            }
            return result;
          })().finally(() => { manualZoomJob = null; });
        }
        return manualZoomJob;
      },
      setAutoZoom() {
        automatic = true;
        desiredManualZoom = null;
        zoomEpoch = null;
        return (manualZoomJob || Promise.resolve()).then(() => automatic
          ? applyZoom(zoomValue(1, range || { min: 1, max: 1 })) : false);
      },
      tick(now) {
        if (active() && Number.isFinite(now) && now - lastRefreshAt >= 1000) {
          lastRefreshAt = now;
          changed(); // Read actual settings again after asynchronous driver changes.
        }
        if (!readyDone || !active() || !canZoom || !automatic || zoomBusy || manualZoomJob || !Number.isFinite(now)) return;
        if (zoomEpoch === null) zoomEpoch = now;
        const target = autoZoom(now - zoomEpoch, range);
        if (target === lastZoom) return;
        zoomBusy = true;
        applyZoom(target).finally(() => { zoomBusy = false; });
      },
      stop() { stopped = true; }
    };
  }

  async function tune(track, isCurrent = () => true) {
    await createController(track, { isCurrent }).ready;
  }

  return Object.freeze({ score, choose, open, tune, isFront, zoomValue, autoZoom, createController });
})();
