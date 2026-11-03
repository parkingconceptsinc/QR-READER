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

## v35: cyberpunk polish

Cyan acquisition corners with violet details, a restrained scan sweep, tap-to-focus feedback and a mint text-capture confirmation make camera states visible. Opening, scanning, paused, image-reading, detected-link and camera-error states follow the actual camera lifecycle. Controls, settings, history and results have short transitions; the live preview appears immediately. Small screens, landscape, safe areas, keyboard focus and reduced motion are supported. The camera and decoder algorithms are unchanged.

## Speed and camera behavior

- Camera, scan guide and primary controls lead the screen. Secondary camera settings are collapsed. The v35 cyberpunk guide uses a small CSS transform/opacity sweep and status light while the camera is active. Panel and control transitions are brief; no blur filters, external assets, visual JavaScript frame loop, or animation delay is added to acquisition, decoding or navigation. The measured crop guide never moves. Effects pause in the background and respect reduced motion. The header reuses the small PCI QR icon instead of loading the large logo image.
- Verified, identified rear lenses skip redundant post-acquisition enumeration. Subsequent camera restarts reuse the device list within the current page session. Device-change events and acquisition failures invalidate that list. Nothing saves a manual lens across visits; return navigation restores automatic selection.
- Main/standard rear lenses and exposed autofocus capabilities outrank identified auxiliary/front lenses. Anonymous devices retain the browser's rear-camera choice. If permission reveals a better rear lens, the initial camera is released before switching. The app does not probe every camera.
- Requests ideal 3840 × 2160 capture at 30 fps without a hard minimum. Capability negotiation supports portrait orientation and gracefully retains a working lower-resolution stream. Actual active settings are shown in the preview.
- Scanning starts alongside tuning. Focus, exposure, white balance and supported points of interest use one driver call with independent optional constraint sets. Rejected combinations fall back independently. Already-current zoom is not reset unnecessarily. Manual focus/zoom controls and conservative automatic zoom remain available where exposed.
- High capture detail is separate from decoding size. Ordinary native crops are capped at 768 pixels on the long side. Threaded fallback crops use 640, or 512 when recent decoding is slow. Every fifth attempt retains a detailed crop; every sixth checks the whole visible preview, with a quiet border around the guide. Fallback detailed passes use up to 1280 pixels when processing allows it. Uploaded images use up to 1600 pixels.
- Preview geometry is reused between layout changes. Native detection avoids CPU pixel readback. The fallback transfers pixels to the worker without drawing a second copy of an already-sized crop.
- Only one live decode can run at a time. Fresh video callbacks drive scanning; unchanged video frames are skipped. Threaded scanning has a 40 ms minimum interval, rather than the former 70 ms. Local main-thread fallback uses 90 ms to leave room for the interface. Device frame rate and actual decode cost also determine cadence.
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

