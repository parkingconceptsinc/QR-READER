# PCI QR Scanner

A static, installable PWA for scanning QR codes with a camera or from an image. HTTP and HTTPS links open automatically in the same tab as soon as they are detected, without confirmation. Other content is displayed for copying. Scan history stays in the browser. Camera access is requested immediately when the app opens. The browser may require permission or a tap before allowing camera access; the Start camera button is available for retrying. Website links open immediately when detected. The native BarcodeDetector API is used when available; otherwise the bundled jsQR 1.4.0 decoder runs locally. Installing/caching the app requires a connection the first time. Opening external websites requires a connection.

The interface, accessibility labels, installation metadata, messages, and history date formatting are in English. Parking Concepts branding is included.

## Deploy to GitHub Pages

1. Upload the contents of this folder to the root of a GitHub repository with a default branch named `main`. The repository uses GitHub Pages branch deployment.
2. Under **Settings → Pages → Build and deployment**, select **Deploy from a branch**, then `main` and `/ (root)`.
3. Push to `main`. GitHub Pages publishes the app at `https://USERNAME.github.io/REPOSITORY/`.

GitHub Pages provides HTTPS, which is required for camera access and the service worker. You can also serve this folder locally with `python3 -m http.server 8000` and open `http://localhost:8000`.

The fallback decoder runs locally in the browser. Camera frames and scanned QR content are never uploaded. If an app asset fails to load, reconnect and reload the page.

When updating an existing installation, publish all files, including `sw.js`, so the updated cache and English interface can be installed.

## Refined camera and home screen icon

The PCI + QR icon includes Android, maskable, and 180px Apple touch variants. Its QR symbol is decorative. Icon filenames are versioned to encourage refresh after deployment. Some devices require removing and re-adding the home screen shortcut to refresh an existing icon.

The camera starts on load, resumes after an active scanning session returns to the foreground, and restarts when returning through browser history. Scanning uses new video frames where supported, with one decode at a time. Session guards discard stale results and close streams from cancelled requests. Live fallback decoding uses a smaller image buffer for less processing; uploaded images retain higher resolution. There is no artificial delay before opening a detected HTTP(S) URL. Actual speed depends on the device, focus, lighting, and network.

## v33 adaptive rear camera and decoding

- Automatically re-evaluates the rear camera on each visit and return from the background. Known front cameras are excluded from the picker and rejected if the browser returns one during a rear request. Legacy saved camera choices are cleared. Manual rear choices apply only to the current visit.
- Prefers identified main/standard rear lenses and exposed autofocus/video capabilities. Anonymous devices without identifying capabilities retain the browser's rear preference rather than relying on list order. If permission reveals additional lens names, it can change to a better identified rear lens without opening every camera to benchmark it.
- Requests an ideal 3840 × 2160 video stream at a preferred 30 fps, then checks the active track capabilities. Detail requests stay within the exposed range, up to 4K, with portrait support and graceful failure. Higher capture detail is kept separate from bounded decoding buffers to limit processing cost. The preview reports the actual resolution; a 4K request does not guarantee 4K delivery or still-photo sensor resolution.
- Applies continuous autofocus (single-shot when that is the available automatic mode), exposure, white balance, and native capture preference when exposed. Optional controls fail independently and camera identity is preserved. Scanning starts alongside tuning.
- Uses native zoom only when a valid range and current setting are exposed. Auto revisits approximately 1×, 1.35×, 1.7×, then 1× at 1.5-second intervals, snapped to device limits/steps. It never pushes auto mode to extreme magnification. The slider allows manual native zoom; Auto resets it. A denied zoom control leaves autofocus and scanning active. No separate pan/tilt permission is requested.
- Refocuses from the focus button or a tap in the preview. Supported points of interest are mapped through the displayed camera crop, and successful zoom/focus settings are retained across subsequent adjustments. No flash is requested.
- Uses native BarcodeDetector when available. Otherwise jsQR runs in a dedicated local worker with transferable pixel buffers. Worker failures and timeouts fall back to the local main-thread decoder. Periodic detail and whole-visible-preview passes improve coverage of small, large, and off-center codes; decode buffers adapt to recent decode cost.
- Updates document, scripts, worker and cache together to v33. All scanner assets, including the decoder worker and its dependency, are installed for offline use. External QR links require connectivity.

The browser does not expose every physical lens, sensor-quality metric, camera-app mode, or an optical/electronic stabilization control through these standard APIs. The app leaves stabilization to the phone/browser defaults; it does not claim to activate a hidden stabilizer. Autofocus, zoom and resolution can vary by browser, permission, lens, lighting and current device conditions. There is no guarantee that a PWA can use the same camera pipeline as a native camera app.

### Validation

Run `node --test tests/*.test.cjs` with Node 18 or newer. No build step or package installation is required. Tests cover rear-only selection, wrong-camera recovery, permission errors, resolution negotiation, zoom bounds and manual/auto races, focus preservation, cancellation, app lifecycle and worker recovery, offline dependency installation, and real normal/inverted QR fixtures decoded in a worker thread.

DOM/media flows use simulated browser objects; the decoder tests use actual QR pixels. These tests do not establish physical camera quality or actual browser rendering. Verify on the target Android/iPhone: actual rear lens and resolution, near/far focus, low-light response, native zoom permission/range, UI responsiveness, offline launch and camera restart after returning from a QR link.
