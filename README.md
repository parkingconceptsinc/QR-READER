# PCI QR Reader

A speed-first, installable QR scanner. The rear camera starts when the page opens; detected HTTP(S) links open in the same tab without confirmation. Other QR content appears for copying while the same focused camera continues scanning. English interface, PCI branding, no account, and no flash control. Images and QR content are processed locally; history remains in the browser.

## Scanner architecture

| File | Responsibility |
| --- | --- |
| `camera.js` | Rear-lens ranking, acquisition, cancellation, hardware focus/zoom and quality negotiation |
| `scanner.js` | Frame scheduling, crop geometry, native detection, local fallback, stale-result guards and decoder timeouts |
| `scan-worker.js` | Bundled jsQR pixel processing off the UI thread |
| `app.js` | Camera lifecycle, controls, navigation, image import and local history |
| `sw.js` | Versioned offline installation, immediate cached launch and background updates |

There is no build step, remote decoder, framework, external font, or CDN dependency.

## v39 viewfinder and launcher

The camera guide stays clear during live scans. A locally bundled lens image appears in the paused and unavailable states. Image import and camera actions share the control panel, with focus available on the preview and lens details in Camera settings. Android gets dedicated opaque, maskable PCI icons at 192 and 512 pixels. The manifest keeps the URL used by v38 installations.

## v38 consecutive scans

The camera accepts a different QR immediately, including when the previous label is also detected. When the camera has seen a clear view for several fresh frames, another label with the same contents can be scanned. Returning with the old label still in view keeps the scanner ready. Live text results leave the viewfinder in place.

After a successful scan, the bundled decoder checks occasional wide frames if native detection keeps missing the next code. A moving preview that stops delivering video callbacks can continue scanning on the same stream.

## v37 camera and Back recovery

New QR links still open automatically. When Back returns to the scanner, the last opened QR stays available through **Open link**. A different code scans immediately. The scanner records the last link on its existing history entry so this also works when the browser rebuilds the page. Chrome may skip a page that opened a link before the user interacted with it. [Chromium history behavior](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/history_manipulation_intervention.md)

Camera requests can be cancelled. Device enumeration, acquisition, video playback and decoder loading have deadlines. The scanner reconnects after a frozen preview or a temporarily busy camera, with up to two delayed retries. A failed link handoff leaves a manual link available. The offline worker can serve a network response when cache access fails.

## v36: faster frame processing and Android icon

The threaded decoder can process each fresh 30 fps frame when it is ready, instead of skipping alternate frames behind a 40 ms minimum. Decoding stays sequential, so slower devices never accumulate a frame queue. Precise video-frame timestamps prevent rounded playback time from suppressing fresh frames.

Four bounded crop surfaces reuse the fast, detailed, wide and combined recovery buffers. After warming up at a stable preview size, these surfaces stop resizing between passes. Local decoding reads directly from the crop without allocating an unused second surface; native-decoder recovery creates CPU-readable surfaces.

The new PCI icon uses a seamless optical-glass finish fading from navy to black, with cyan scanner accents. Android gets a full-bleed opaque maskable variant with the complete emblem inside the central safe circle; ordinary launcher, Apple touch, header and favicon sizes have dedicated PNG assets. The header uses the 96px variant (under 7 KB), and the document, manifest, assets and offline shell are versioned together.

## v35: cyberpunk polish

Cyan acquisition corners with violet details, a restrained scan sweep, tap-to-focus feedback and a mint text-capture confirmation make camera states visible. Opening, scanning, paused, image-reading, detected-link and camera-error states follow the actual camera lifecycle. Controls, settings, history and results have short transitions; the live preview appears immediately. Small screens, landscape, safe areas, keyboard focus and reduced motion are supported. The camera and decoder algorithms are unchanged.

## Speed and camera behavior

- The camera, static scan guide and primary actions lead the screen. A brief capture confirmation respects reduced motion. The live view uses no decorative image, continuous animation or visual JavaScript loop. The header uses a small local icon.
- Verified, identified rear lenses skip redundant post-acquisition enumeration. Subsequent camera restarts reuse the device list within the current page session. Device-change events and acquisition failures invalidate that list. Nothing saves a manual lens across visits; return navigation restores automatic selection.
- Main/standard rear lenses and exposed autofocus capabilities outrank identified auxiliary/front lenses. Anonymous devices retain the browser's rear-camera choice. If permission reveals a better rear lens, the initial camera is released before switching. The app does not probe every camera.
- Requests ideal 3840 × 2160 capture at 30 fps without a hard minimum. Capability negotiation supports portrait orientation and gracefully retains a working lower-resolution stream. Actual active settings are shown under Camera settings.
- Scanning starts alongside tuning. Focus, exposure, white balance and supported points of interest use one driver call with independent optional constraint sets. Rejected combinations fall back independently. Already-current zoom is not reset unnecessarily. Manual focus/zoom controls and conservative automatic zoom remain available where exposed.
- High capture detail is separate from decoding size. Ordinary native crops are capped at 768 pixels on the long side. Threaded fallback crops use 640, or 512 when recent decoding is slow. Every fifth attempt retains a detailed crop; every sixth checks the whole visible preview, with a quiet border around the guide. Fallback detailed passes use up to 1280 pixels when processing allows it. Uploaded images use up to 1600 pixels.
- Preview geometry is reused between layout changes. Native detection avoids CPU pixel readback. Four bounded crop surfaces avoid repeated resizing between recovery passes. The fallback transfers pixels to the worker without drawing a second copy of an already-sized crop.
- Only one live decode can run at a time. Fresh video callbacks drive scanning; unchanged video frames are skipped using precise metadata where available. Native and threaded scanning use a 25 ms minimum interval. Local main-thread fallback uses 90 ms to leave room for the interface. Device frame rate and actual decode cost also determine cadence.
- A native decode stalled for 1200 ms switches to the bundled decoder. Failed/stalled workers fall back locally. Stale results cannot open links after a camera stop/restart. Consecutive text codes keep the same focused camera; duplicate text is suppressed briefly.
- Backgrounding, returning through browser history, manual stop/retry and interrupted cameras have explicit lifecycle guards. Camera streams from cancelled requests are released. Updates register after acquisition and do not reload an active scanner.
- Installed launches return the cached document without waiting for network requests. Refresh runs in the background. Future documents do not replace the current offline shell before their matching worker/assets are installed.

Camera permission still belongs to the browser/OS. A tap or site-settings change may be needed when permission is blocked. Browsers do not expose every lens, sensor quality metric, stabilization control or native camera mode. Performance and available focus/zoom/resolution vary by phone, browser, lighting and distance; a 4K preference does not guarantee 4K delivery. External QR links require connectivity.

## Development and deployment

Serve locally with `python3 -m http.server 8000` and open `http://localhost:8000`. Production camera access requires HTTPS. GitHub Pages serves `main` from the repository root. Develop on a separate branch, run validation, and merge the complete versioned shell together. When releasing, update the document, script/worker URLs, service-worker cache and shell-version checks consistently.

The initial install needs a connection. Installed scanner dependencies, including jsQR and its worker, work offline. A new worker takes effect for subsequent page loads without interrupting a scan. Icons include Android, maskable and Apple touch variants.

## Validation

Run `node --test tests/*.test.cjs` with Node 18 or newer. No dependency installation is required. Tests cover rear-only ranking and recovery, enumeration reuse/invalidation, hardware constraints and rejected controls, zoom/focus races, camera permission and return navigation, stale/frozen frames, single-decode scheduling, native/worker timeouts, consecutive text scans, offline dependency loading and slow-network launches. Worker tests decode actual normal/inverted QR pixels.

DOM/media tests use simulated browser objects. They establish pipeline behavior, not physical sensor quality or end-to-end latency on a phone. Final device checks: Android/iPhone launch, actual rear lens/resolution, near/far and dim-light scans, off-center/inverted codes, automatic link opening and Back to camera, manual zoom/focus, image import and offline startup.

