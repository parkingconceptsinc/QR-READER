# PCI QR Scanner

A static, installable PWA for scanning QR codes with a camera or from an image. HTTP and HTTPS links open automatically in the same tab as soon as they are detected, without confirmation. Other content is displayed for copying. Scan history stays in the browser. Camera access is requested immediately when the app opens. There are no animations or transitions. The browser may require permission or a tap before allowing camera access; the Start camera button is available for retrying. Website links open immediately when detected. The native BarcodeDetector API is used when available; otherwise jsQR 1.4.0 is downloaded from jsDelivr and cached locally. The fallback requires an internet connection the first time. Opening external websites requires a connection.

The interface, accessibility labels, installation metadata, messages, and history date formatting are in English. Parking Concepts branding is included.

## Deploy to GitHub Pages

1. Upload the contents of this folder to the root of a GitHub repository with a default branch named `main`. Include the `.github` folder.
2. Under **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Push to `main`. The included workflow publishes the app at `https://USERNAME.github.io/REPOSITORY/`.

GitHub Pages provides HTTPS, which is required for camera access and the service worker. You can also serve this folder locally with `python3 -m http.server 8000` and open `http://localhost:8000`.

The fallback decoder runs locally in the browser. Camera frames and scanned QR content are never uploaded. If the fallback download fails, reconnect and reload the page.

When updating an existing installation, publish all files, including `sw.js`, so the updated cache and English interface can be installed.

## Refined camera and home screen icon

The PCI + QR icon includes Android, maskable, and 180px Apple touch variants. Its QR symbol is decorative. Icon filenames are versioned to encourage refresh after deployment. Some devices require removing and re-adding the home screen shortcut to refresh an existing icon.

The camera starts on load, resumes after an active scanning session returns to the foreground, and restarts when returning through browser history. Scanning uses new video frames where supported, with one decode at a time. Session guards discard stale results and close streams from cancelled requests. Live fallback decoding uses a smaller image buffer for less processing; uploaded images retain higher resolution. There is no artificial delay before opening a detected HTTP(S) URL. Actual speed depends on the device, focus, lighting, and network.
