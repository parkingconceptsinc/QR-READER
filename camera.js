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
    const check = () => {
      if (isCurrent()) return;
      close(opened);
      throw new DOMException('Camera request cancelled.', 'AbortError');
    };
    async function acquire(id = '') {
      const identity = id ? { deviceId: { exact: id } } : { facingMode: { ideal: facingMode } };
      const quality = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } };
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

  async function tune(track, isCurrent = () => true) {
    let capabilities;
    try { capabilities = track.getCapabilities?.() || {}; } catch { return; }
    if (!track.applyConstraints) return;
    const base = track.getConstraints?.() || {};
    const applied = {};
    // Preserve each accepted setting when another setting is applied. A rejected
    // optional control must not disable the camera or discard autofocus.
    for (const property of ['focusMode', 'exposureMode', 'whiteBalanceMode']) {
      if (!isCurrent() || track.readyState === 'ended') return;
      if (!capabilities[property]?.includes('continuous')) continue;
      const candidate = { ...applied, [property]: 'continuous' };
      try {
        await track.applyConstraints({ ...base, advanced: [{ ...candidate }] });
        Object.assign(applied, candidate);
      } catch { /* Keep the browser defaults for unsupported optional controls. */ }
    }
  }

  return Object.freeze({ score, choose, open, tune });
})();
