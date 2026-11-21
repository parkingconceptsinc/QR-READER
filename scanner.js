/* QR decoding and frame scheduling are independent of camera acquisition and UI. */
globalThis.QRScanner = (() => {
  function fallbackDetector() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let frameCount = 0;
    let decoderReady = null;
    let cancelLoad = null;
    let disposed = false;
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
        worker = new Worker('./scan-worker.js?v=38');
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
        function finish() {
          clearTimeout(timer);
          script.onload = script.onerror = null;
          script.remove?.();
          cancelLoad = null;
        }
        function fail() {
          finish();
          reject(new Error('The built-in QR decoder could not load. Tap Retry scanner.'));
        }
        const timer = setTimeout(fail, 4500);
        cancelLoad = fail;
        script.src = './vendor/jsQR.js';
        script.async = true;
        script.onload = () => {
          if (!window.jsQR) return fail();
          finish();
          resolve();
        };
        script.onerror = fail;
        try { document.head.append(script); } catch { fail(); }
      }).catch(error => {
        decoderReady = null;
        throw error;
      });
      return decoderReady;
    }
    // Preload only on browsers without workers. It never delays camera access.
    if (!worker) loadDecoder().catch(() => {});
    return {
      get busy() { return pending.size > 0 || cancelLoad !== null; },
      dispose() {
        disposed = true;
        failWorker();
        cancelLoad?.();
      },
      get threaded() { return Boolean(worker); },
      async detect(source, live = false, checkInverted = false) {
        if (!context) throw new Error('The built-in QR decoder is unavailable.');
        const width = source.videoWidth || source.width;
        const height = source.videoHeight || source.height;
        if (!width || !height) return [];
        const scale = Math.min(1, (live ? 1280 : 1600) / Math.max(width, height));
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const pixelsContext = live && width === w && height === h && source.getContext
          ? source.getContext('2d', { willReadFrequently: true }) : context;
        if (pixelsContext === context) {
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          context.drawImage(source, 0, 0, w, h);
        }
        let pixels = pixelsContext.getImageData(0, 0, w, h);
        const inversionAttempts = !live || ++frameCount % 5 === 0 || checkInverted ? 'attemptBoth' : 'dontInvert';
        if (worker) {
          try {
            return await new Promise((resolve, reject) => {
              const id = ++requestId;
              const timer = setTimeout(failWorker, live ? 1800 : 5000);
              pending.set(id, { resolve, reject, timer });
              worker.postMessage({ id, width: w, height: h, buffer: pixels.data.buffer,
                inversionAttempts }, [pixels.data.buffer]);
            });
          } catch (error) {
            if (disposed) throw error;
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

  function create({ video, stage, frame, onResult, onDetections, isHeld = () => false, preferFallback = false,
    onError, onStall, onTick = () => {} }) {
    const report = onDetections || (codes => {
      const code = codes.find(code => typeof code.rawValue === 'string' && code.rawValue.length);
      if (code) onResult(code.rawValue);
    });
    let detector;
    let native = false;
    let secondDecoder = null;
    let hasDecoded = false;
    let nextCheckAt = 0;
    const isNew = code => typeof code.rawValue === 'string' && code.rawValue.length && !isHeld(code.rawValue);
    try {
      if (preferFallback || !window.BarcodeDetector) throw new Error('Use local decoder');
      detector = new BarcodeDetector({ formats: ['qr_code'] });
      native = true;
    } catch { detector = fallbackDetector(); }
    // Keep one bounded surface per crop profile. Alternating detailed/wide
    // passes must not reallocate the ordinary crop on the following frame.
    const surfaces = new Map();
    function surface(profile) {
      if (!surfaces.has(profile)) {
        const canvas = document.createElement('canvas');
        surfaces.set(profile, { canvas,
          context: canvas.getContext('2d', { willReadFrequently: !native }) });
      }
      return surfaces.get(profile);
    }
    let running = false;
    let failed = false;
    let epoch = 0;
    let frameHandle = null;
    let useVideoFrames = false;
    let playbackAtLastFrame = 0;
    let job = null;
    let frameTimer = null;
    let lastFrameAt = 0;
    let lastAttempt = -Infinity;
    let lastVideoTime = -1;
    let lastPresentedFrame;
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
      if (!width || !height) return video;
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
      const { canvas, context } = surface(wide ? (detailed ? 'wide-detail' : 'wide') : detailed ? 'detail' : 'fast');
      if (!context) return video;
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
      if (useVideoFrames) video.cancelVideoFrameCallback?.(frameHandle);
      else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    function schedule() {
      if (!running || failed || frameHandle !== null || job) return;
      const current = epoch;
      const videoCallback = useVideoFrames;
      const callback = (timestamp, metadata) => {
        if (current !== epoch || videoCallback !== useVideoFrames) return;
        frameHandle = null;
        return scan(current, metadata);
      };
      frameHandle = useVideoFrames
        ? video.requestVideoFrameCallback(callback) : requestAnimationFrame(callback);
    }
    function watchFrames(current) {
      if (!onStall) return;
      const timeout = 4000;
      lastFrameAt = performance.now();
      function check() {
        if (!running || current !== epoch || failed) return;
        // A decoder owns the frame until its own deadline. A silent video
        // source, including one that no longer calls back, needs a new stream.
        const remaining = timeout - (performance.now() - lastFrameAt);
        if (!job && remaining <= 0) {
          // Some resumed previews keep playing but stop sending video callbacks.
          if (useVideoFrames && video.readyState >= 2 && Number.isFinite(video.currentTime) &&
              video.currentTime > playbackAtLastFrame && typeof requestAnimationFrame === 'function') {
            cancelFrame();
            useVideoFrames = false;
            lastVideoTime = -1;
            lastFrameAt = performance.now();
            schedule();
          } else { onStall(); return; }
        }
        frameTimer = setTimeout(check, !job && remaining > 0 ? remaining : timeout);
      }
      frameTimer = setTimeout(check, timeout);
    }
    function useFallback() {
      detector = secondDecoder || fallbackDetector();
      secondDecoder = null;
      native = false;
      surfaces.clear();
    }
    function resetFailedDetector() {
      if (!failed) return;
      detector.dispose?.();
      useFallback();
      failed = false;
    }
    async function decode(source, live, wide = false) {
      if (!native) return detector.detect(source, live, wide);
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
    async function scan(current, metadata) {
      if (!running || current !== epoch || failed) return;
      const now = performance.now();
      onTick(now);
      // One decode at a time. The fallback resumes on the next fresh frame;
      // no extra fixed 70 ms pause after an expensive decode.
      // A 40 ms minimum skips every other 30 fps camera frame even when the
      // worker is ready. Slow decoders still apply backpressure through job.
      const interval = native || detector.threaded ? 25 : 90;
      // Frame metadata stays precise when privacy settings round currentTime.
      const videoTime = Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : video.currentTime;
      const presented = metadata?.presentedFrames;
      const sameFrame = Number.isFinite(presented) ? presented === lastPresentedFrame
        : Number.isFinite(videoTime) && videoTime === lastVideoTime;
      if (job || video.readyState < 2 || now - lastAttempt < interval || sameFrame) {
        schedule();
        return;
      }
      lastAttempt = now;
      lastFrameAt = now;
      lastVideoTime = videoTime;
      lastPresentedFrame = presented;
      playbackAtLastFrame = video.currentTime;
      count++;
      job = (async () => {
        try {
          const wide = count % 6 === 0;
          const source = capture(now);
          let codes = await decode(source, true, wide);
          if (!running || current !== epoch) return;
          let checkedWide = wide && !native;
          // Some native scanners keep returning an empty list (or the old
          // label) on a live stream. Check a wide frame with jsQR on misses.
          if (native && hasDecoded && wide && now >= nextCheckAt && !codes.some(isNew)) {
            nextCheckAt = now + 1000;
            secondDecoder ??= fallbackDetector();
            let additional = [];
            try { additional = await secondDecoder.detect(source, true, true); }
            catch { if (current === epoch) nextCheckAt = performance.now() + 5000; }
            if (!running || current !== epoch) return;
            checkedWide = true;
            if (additional.some(isNew)) useFallback();
            if (additional.length) codes = codes.concat(additional);
          }
          if (codes.length) hasDecoded = true;
          const duration = performance.now() - now;
          averageMs = averageMs ? averageMs * 0.8 + duration * 0.2 : duration;
          errors = 0;
          report(codes, now, checkedWide);
        } catch (error) {
          if (!running || current !== epoch) return;
          if (native) {
            useFallback();
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
      start(resumingAfterScan = false) {
        cancelFrame();
        clearTimeout(frameTimer);
        epoch++;
        running = true;
        useVideoFrames = typeof video.requestVideoFrameCallback === 'function';
        playbackAtLastFrame = video.currentTime;
        hasDecoded ||= resumingAfterScan;
        nextCheckAt = performance.now() + 800;
        resetFailedDetector();
        errors = count = averageMs = 0;
        lastAttempt = geometryAt = -Infinity;
        lastVideoTime = -1;
        lastPresentedFrame = undefined;
        invalidate();
        watchFrames(epoch);
        schedule();
      },
      stop() {
        running = false;
        epoch++;
        cancelFrame();
        clearTimeout(frameTimer);
        if (secondDecoder?.busy) {
          secondDecoder.dispose();
          secondDecoder = null;
        }
        if (job && detector.busy) {
          detector.dispose();
          failed = true;
        }
      },
      async read(source) {
        const current = epoch;
        while (job) await job.catch(() => {});
        if (current !== epoch) throw new Error('Image scan cancelled.');
        resetFailedDetector();
        job = decode(source, false).catch(error => {
          if (!native || current !== epoch) throw error;
          useFallback();
          return detector.detect(source, false);
        });
        try { return await job; }
        finally { job = null; schedule(); }
      },
      get mode() { return native ? 'native' : detector.threaded ? 'worker' : 'local'; }
    };
  }
  return Object.freeze({ create });
})();

