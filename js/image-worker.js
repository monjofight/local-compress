// Encodes images off the main thread. On the main thread Chrome runs canvas encoding at idle
// priority, which made the quality slider lag by about a second.

let source = null; // ImageBitmap of the open image

self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    source?.close();
    source = data.bitmap;
    return;
  }
  try {
    self.postMessage({ id: data.id, blob: await encode(source, data) });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message ?? error) });
  }
};

async function encode(bitmap, { width, height, rotation, mime, quality, opaque }) {
  if (!bitmap) throw new Error('No image is loaded.');

  // Resize first with high-quality filtering, then rotate while drawing onto the output canvas.
  const sideways = rotation === 90 || rotation === 270;
  const drawWidth = sideways ? height : width;
  const drawHeight = sideways ? width : height;
  const resized = drawWidth === bitmap.width && drawHeight === bitmap.height
    ? bitmap
    : await createImageBitmap(bitmap, { resizeWidth: drawWidth, resizeHeight: drawHeight, resizeQuality: 'high' });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (opaque) {
    // Formats without transparency get a white background instead of black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(resized, -drawWidth / 2, -drawHeight / 2);
  if (resized !== bitmap) resized.close();

  return canvas.convertToBlob({ type: mime, quality });
}
