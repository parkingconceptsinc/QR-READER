# PCI QR Scanner

A static, installable PWA for scanning QR codes with a camera or from an image. HTTP and HTTPS links open automatically in the same tab as soon as they are detected, without confirmation. Other content is displayed for copying. Scan history stays in the browser. Camera access is requested immediately when the app opens. There are no animations or transitions. The browser may require permission or a tap before allowing camera access; the Start camera button is available for retrying. Website links open immediately when detected. The native BarcodeDetector API is used when available; otherwise the bundled jsQR 1.4.0 decoder runs locally. Installing/caching the app requires a connection the first time. Opening external websites requires a connection.

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

## v32 camera selection and decoding

- Requests a rear camera at an ideal 1920 × 1080, up to 30 fps, with relaxed fallbacks for older devices. The actual resolution is shown on the preview.
- Uses available device labels and per-device capabilities (when exposed without opening extra cameras) to prefer the main/standard rear lens over identified ultra wide, telephoto, macro, depth, or virtual lenses. After permission unlocks names, it can switch once to a better identified lens; it never opens all lenses to benchmark them. Generic labels can use exposed autofocus and video resolution as tie-breakers. Anonymous devices without capabilities keep the browser default rather than guessing from enumeration order.
- The Camera selector exposes individual lenses when the browser provides multiple devices. Automatic returns to the main rear preference. A manual lens choice is remembered on this device; an unavailable saved choice falls back automatically. A front/rear switch remains available.
- Applies continuous focus, exposure and white balance only when advertised by the active track. Each optional control can fail independently. Scanning begins before tuning completes. No flash or elevated zoom permission is requested.
- Preserves source proportions and resolution within a bounded decoding buffer. The guide crop includes extra border, with a whole-visible-preview pass every sixth processed frame to catch large or off-center codes.
- Versioned scripts and the worker cache are updated together. The local decoder, new camera module and shell are cached for offline use; external QR links still need connectivity.

Browsers do not expose sensor quality, every physical lens, or all native camera controls. Camera labels and capabilities are a best effort, not a guarantee of the phone's highest quality sensor. Verify the displayed lens and actual resolution on the target Android/iPhone; choose another exposed lens if its automatic selection is unsuitable.

### Validation

Run `node --test tests/*.test.cjs` for camera ranking, permission errors, missing/busy lenses, cancelled requests and optional-control failures. No build step or package installation is required. Hardware autofocus, low-light performance and phone-specific lens names require a physical-device check.
