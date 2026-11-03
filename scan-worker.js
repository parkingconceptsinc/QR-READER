/* Keep QR pixel processing off the camera/UI thread. No network or camera access. */
importScripts('./vendor/jsQR.js');
self.onmessage = ({ data }) => {
  const { id, width, height, buffer, inversionAttempts } = data;
  try {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width * height > 4000000 || buffer.byteLength !== width * height * 4) {
      throw new Error('Invalid QR frame.');
    }
    const code = jsQR(new Uint8ClampedArray(buffer), width, height, { inversionAttempts });
    self.postMessage({ id, codes: code ? [{ rawValue: code.data }] : [] });
  } catch (error) {
    self.postMessage({ id, error: error.message || 'QR frame could not be processed.' });
  }
};
