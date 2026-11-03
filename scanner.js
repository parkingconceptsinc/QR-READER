/* QR decoding and frame scheduling are independent of camera acquisition and UI. */
globalThis.QRScanner = (() => {
  function fallbackDetector() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let frameCount = 0;
    let decoderReady = null;
    let worker = null;
    let requestId = 0;
    const pending = new Map();
    function failWorker() {
      worker?.terminate();
      worker = null;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('QR worker unavailable.'));
      }
      pending.clear();
    }
    try {
      if (typeof Worker === 'function') {
        worker = new Worker('./scan-worker.js?v=35');
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
        script.src = './vendor/jsQR.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
          decoderReady = null;
          reject(new Error('The built-in QR decoder could not load. Tap Retry scanner.'));
        };
        document.head.append(script);
      });
      return decoderReady;
    }
    // Preload only on browsers without workers. It never delays camera access.
    if (!worker) loadDecoder().catch(() => {});
    return {
      dispose: failWorker,
      get threaded() { return Boolean(worker); },
      async detect(source, live = false) {
        if (!context) throw new Error('The built-in QR decoder is unavailable.');
        const width = source.videoWidth || source.width;
        const height = source.videoHeight || source.height;
        if (!width || !height) return [];
        const scale = Math.min(1, (live ? 1280 : 1600) / Math.max(width, height));
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const pixelsContext = live && width === w && height === h && source.getContext
          ? source.getContext('2d', { willReadFrequently: true }) : context;
        if (pixelsContext === context) context.drawImage(source, 0, 0, w, h);
        let pixels = pixelsContext.getImageData(0, 0, w, h);
        const inversionAttempts = !live || ++frameCount % 5 === 0 ? 'attemptBoth' : 'dontInvert';
        if (worker) {
          try {
            return await new Promise((resolve, reject) => {
              const id = ++requestId;
              const timer = setTimeout(failWorker, live ? 1800 : 5000);
              pending.set(id, { resolve, reject, timer });
              worker.postMessage({ id, width: w, height: h, buffer: pixels.data.buffer,
                inversionAttempts }, [pixels.data.buffer]);
            });
          } catch {
            failWorker();
            pixels = pixelsContext.getImageData(0, 0, w, h);
          }
        }
        await loadDecoder();
        if (!window.jsQR) throw new Error('The built-in QR decoder is unavailable.');
        const code = window.jsQR(pixels.data, w, h, { inversionAttempts });
        return code ? [{ rawValue: code.data }] : [];
      }
    };
  }

  function create({ video, stage, frame, onResult, onError, onTick = () => {} }) {
    const canvas = document.createElement('canvas');
    let detector;
    let native = false;
    try {
      if (!window.BarcodeDetector) throw new Error('Use local decoder');
      detector = new BarcodeDetector({ formats: ['qr_code'] });
      native = true;
    } catch { detector = fallbackDetector(); }
    // Only the local decoder needs a synchronous CPU pixel readback.
    const context = canvas.getContext('2d', { willReadFrequently: !native });
    let running = false;
    let failed = false;
    let epoch = 0;
    let frameHandle = null;
    let job = null;
    let lastAttempt = -Infinity;
    let lastVideoTime = -1;
    let count = 0;
    let averageMs = 0;
    let errors = 0;
    let geometry = null;
    let geometryAt = -Infinity;
    const invalidate = () => { geometry = null; };
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(invalidate);
      observer.observe(stage);
      observer.observe(frame);
    }
    window.addEventListener('resize', invalidate);
    window.addEventListener('orientationchange', invalidate);

    function capture(now) {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!context || !width || !height) return video;
      if (!geometry || geometry.width !== width || geometry.height !== height || now - geometryAt > 500) {
        const s = stage.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        if (!s.width || !s.height || !f.width) return video;
        const fit = Math.max(s.width / width, s.height / height);
        geometry = { width, height, fit, s, f };
        geometryAt = now;
      }
      const { fit, s, f } = geometry;
      const wide = count % 6 === 0;
      const detailed = count % 5 === 0;
      const cx = width / 2 + (f.left + f.width / 2 - s.left - s.width / 2) / fit;
      const cy = height / 2 + (f.top + f.height / 2 - s.top - s.height / 2) / fit;
      const sw = Math.min(width, (wide ? s.width : f.width * 1.18) / fit);
      const sh = Math.min(height, (wide ? s.height : f.height * 1.18) / fit);
      const sx = Math.max(0, Math.min(width - sw, cx - sw / 2));
      const sy = Math.max(0, Math.min(height - sh, cy - sh / 2));
      // Fast ordinary crops; periodic detail/wide passes retain difficult codes.
      const limit = native ? (detailed ? 1600 : wide ? 960 : 768)
        : detailed || wide ? (detector.threaded && averageMs < 140 ? 1280 : 960)
          : averageMs > 100 ? 512 : 640;
      const scale = Math.min(1, limit / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      context.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      return canvas;
    }

    function cancelFrame() {
      if (frameHandle === null) return;
      if (video.cancelVideoFrameCallback && video.requestVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    function schedule() {
      if (!running || failed || frameHandle !== null || job) return;
      const current = epoch;
      const callback = () => {
        if (current !== epoch) return;
        frameHandle = null;
        return scan(current);
      };
      frameHandle = video.requestVideoFrameCallback
        ? video.requestVideoFrameCallback(callback) : requestAnimationFrame(callback);
    }
    async function decode(source, live) {
      if (!native) return detector.detect(source, live);
      let timer;
      try {
        return await Promise.race([
          detector.detect(source),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Native QR decoder timed out.')), live ? 1200 : 5000);
          })
        ]);
      } finally { clearTimeout(timer); }
    }
    async function scan(current) {
      if (!running || current !== epoch || failed) return;
      const now = performance.now();
      onTick(now);
      // One decode at a time. The fallback resumes on the next fresh frame;
      // no extra fixed 70 ms pause after an expensive decode.
      const interval = native ? 25 : detector.threaded ? 40 : 90;
      if (job || video.readyState < 2 || now - lastAttempt < interval ||
          (Number.isFinite(video.currentTime) && video.currentTime === lastVideoTime)) {
        schedule();
        return;
      }
      lastAttempt = now;
      lastVideoTime = video.currentTime;
      count++;
      job = (async () => {
        try {
          const codes = await decode(capture(now), true);
          if (!running || current !== epoch) return;
          const duration = performance.now() - now;
          averageMs = averageMs ? averageMs * 0.8 + duration * 0.2 : duration;
          errors = 0;
          const value = codes.find(code => typeof code.rawValue === 'string' && code.rawValue.length)?.rawValue;
          if (value) onResult(value);
        } catch (error) {
          if (!running || current !== epoch) return;
          if (native) {
            detector = fallbackDetector();
            native = false;
            errors = 0;
          } else if (++errors >= 3 || error.message?.startsWith('The built-in QR decoder')) {
            failed = true;
            onError(error);
          }
        }
      })();
      await job;
      job = null;
      schedule();
    }

    return {
      start() {
        cancelFrame();
        epoch++;
        running = true;
        if (failed) { detector.dispose?.(); detector = fallbackDetector(); native = false; }
        failed = false;
        errors = count = averageMs = 0;
        lastAttempt = geometryAt = -Infinity;
        lastVideoTime = -1;
        invalidate();
        schedule();
      },
      stop() { running = false; epoch++; cancelFrame(); },
      async read(source) {
        // A stopped live decode may still own the fallback scratch canvas.
        if (job) await job;
        try { return await decode(source, false); }
        catch (error) {
          if (!native) throw error;
          detector = fallbackDetector(); native = false;
          return detector.detect(source, false);
        }
      },
      get mode() { return native ? 'native' : detector.threaded ? 'worker' : 'local'; }
    };
  }
  return Object.freeze({ create });
})();

