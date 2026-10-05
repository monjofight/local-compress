// Image mode: the original on the left, and on the right the same image re-encoded with the
// current settings. Every change re-encodes in a worker.
import * as view from './compare-view.js';
import {
  $, UserError, baseName, downloadFile, errorMessage, formatBytes, icon, renderNotes, renderSummary, setFileHeader,
} from './ui.js';

const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG', lossy: true, alpha: false, hint: 'どこでも開ける一般的な形式です。' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP', lossy: true, alpha: true, hint: 'JPEGより小さくなりやすく、透明も残せます。' },
  png: { mime: 'image/png', ext: 'png', label: 'PNG', lossy: false, alpha: true, hint: '画質は落ちません。写真だとサイズが大きくなりがちです。' },
};
const TYPE_LABELS = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/avif': 'AVIF', 'image/gif': 'GIF', 'image/bmp': 'BMP' };
const MAX_SIDE = 16384;

const settings = { format: 'jpeg', quality: 75, resize: false, width: 0, height: 0, keepRatio: true };
let image = null;   // { file, width, height, type, hasAlpha, url }
let output = null;  // { blob, url, width, height, format }
let rotation = 0;
let encoding = false;
let changedDuringEncode = false;
let error = '';
let session = 0;    // bumps on close, so late results of a closed image are dropped

// ---------- worker

const worker = new Worker(new URL('./image-worker.js', import.meta.url));
const requests = new Map();
let lastRequestId = 0;

worker.onmessage = ({ data }) => {
  const request = requests.get(data.id);
  requests.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.blob);
};

function encodeInWorker(job) {
  const id = ++lastRequestId;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    worker.postMessage({ type: 'encode', id, ...job });
  });
}

// ---------- editor interface

export async function open(file) {
  const id = ++session;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    const heic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
    throw new UserError(heic
      ? 'HEIC形式の写真は、Chromeでは読み込めません。iPhoneの写真アプリで「書き出す」からJPEGにするか、カメラの設定を「互換性優先」にして撮影してください。'
      : `「${file.name}」は画像として読み込めませんでした。JPEG・PNG・WebP・AVIF・GIFの画像を選んでください。`);
  }
  if (id !== session) {
    bitmap.close();
    return;
  }

  image = {
    file,
    width: bitmap.width,
    height: bitmap.height,
    type: TYPE_LABELS[file.type] ?? file.name.split('.').pop().toUpperCase(),
    hasAlpha: file.type !== 'image/jpeg' && hasTransparency(bitmap),
    url: URL.createObjectURL(file),
  };
  worker.postMessage({ type: 'load', bitmap }, [bitmap]);

  rotation = 0;
  Object.assign(settings, { resize: false, width: 0, height: 0 });
  if (image.hasAlpha && !FORMATS[settings.format].alpha) settings.format = 'webp';

  $('image-settings').hidden = false;
  $('before-img').src = image.url;
  view.rotateOriginal($('before-img'), 0);
  view.setSize(image.width, image.height);
  renderMeta();
  update();
}

export function close() {
  session++;
  changedDuringEncode = false;
  worker.postMessage({ type: 'load', bitmap: null });
  if (image) URL.revokeObjectURL(image.url);
  if (output) URL.revokeObjectURL(output.url);
  image = null;
  output = null;
  error = '';
  $('before-img').removeAttribute('src');
  $('after-img').removeAttribute('src');
  view.rotateOriginal($('before-img'), 0);
  $('image-settings').hidden = true;
}

export function rotate() {
  if (!image) return;
  rotation = (rotation + 90) % 360;
  if (settings.resize) [settings.width, settings.height] = [settings.height, settings.width];
  const { width, height } = orientedSize();
  view.rotateOriginal($('before-img'), rotation, image.width, image.height);
  view.setSize(width, height);
  renderMeta();
  update();
}

export function onPrimary() {
  if (!output || encoding) return;
  downloadFile(output.blob, `${baseName(image.file.name)}_compressed.${FORMATS[output.format].ext}`);
}

export const onKeyDown = () => {};
export const isBusy = () => false;

// ---------- encoding

/** Re-encodes with the current settings. Changes made during an encode are folded into one more run. */
async function update() {
  if (encoding) {
    changedDuringEncode = true;
    render();
    return;
  }
  encoding = true;
  render();
  try {
    do {
      changedDuringEncode = false;
      const current = image;
      if (!current) break;
      try {
        const result = await encode(current, { ...settings });
        if (current === image && !changedDuringEncode) await showOutput(result);
        error = '';
      } catch (e) {
        if (current === image && !changedDuringEncode) error = errorMessage(e);
      }
    } while (changedDuringEncode);
  } finally {
    encoding = false;
    render();
  }
}

async function encode(source, options) {
  const format = FORMATS[options.format];
  const { width, height } = outputSize(source, options);
  const blob = await encodeInWorker({
    width,
    height,
    rotation,
    mime: format.mime,
    quality: format.lossy ? options.quality / 100 : undefined,
    opaque: !format.alpha,
  });
  // Browsers fall back to PNG for types they cannot write.
  if (blob.type !== format.mime) throw new UserError(`${format.label}形式は、このブラウザでは書き出せません。別の形式を選んでください。`);
  return { blob, width, height, format: options.format };
}

async function showOutput(result) {
  const url = URL.createObjectURL(result.blob);
  await loadImage($('after-img'), url);
  if (output) URL.revokeObjectURL(output.url);
  output = { ...result, url };
}

// Resolves once the new picture has loaded, so the size label changes together with the picture.
// (img.decode() is not used: it can stall while the page is not being painted.)
function loadImage(img, url) {
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
      resolve();
    };
    timer = setTimeout(done, 3000);
    img.addEventListener('load', done);
    img.addEventListener('error', done);
    img.src = url;
  });
}

// ---------- sizes

function orientedSize(source = image) {
  return rotation % 180 ? { width: source.height, height: source.width } : { width: source.width, height: source.height };
}

function validSize({ width, height }) {
  return [width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SIDE);
}

function outputSize(source, options) {
  return options.resize && validSize(options) ? { width: options.width, height: options.height } : orientedSize(source);
}

/** With "keep aspect ratio" on, derives one side from the other. */
function matchRatio(changed) {
  if (!image || !settings.keepRatio) return;
  const { width, height } = orientedSize();
  if (changed === 'width' && settings.width > 0) settings.height = Math.max(1, Math.round((settings.width * height) / width));
  if (changed === 'height' && settings.height > 0) settings.width = Math.max(1, Math.round((settings.height * width) / height));
}

function hasTransparency(bitmap) {
  const width = Math.min(256, bitmap.width);
  const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

// ---------- rendering

function renderMeta() {
  const { width, height } = orientedSize();
  setFileHeader({ meta: `${width} × ${height} · ${image.type || '画像'} · ${formatBytes(image.file.size)}` });
}

function render() {
  if (!image) return;
  const format = FORMATS[settings.format];
  const editing = (id) => document.activeElement === $(id);

  $('img-format').value = settings.format;
  $('img-format-hint').textContent = format.hint;
  $('img-quality-group').hidden = !format.lossy;
  $('img-quality').value = String(settings.quality);
  $('img-quality').style.setProperty('--fill', `${((settings.quality - 1) / 99) * 100}%`);
  $('img-quality-value').textContent = String(settings.quality);
  $('img-resize').checked = settings.resize;
  $('img-resize-fields').hidden = !settings.resize;
  if (!editing('img-width')) $('img-width').value = settings.width ? String(settings.width) : '';
  if (!editing('img-height')) $('img-height').value = settings.height ? String(settings.height) : '';
  $('img-keep-ratio').checked = settings.keepRatio;
  const size = outputSize(image, settings);
  $('img-output-size').textContent = `出力サイズ：${size.width} × ${size.height} px`;
  renderNotes($('img-notes'), notes());

  view.setLabels(
    `圧縮前 · ${formatBytes(image.file.size)}`,
    output ? `圧縮後 · ${formatBytes(output.blob.size)}` : '圧縮後 · 処理中…',
  );
  renderSummary(image.file.size, output?.blob.size);

  const ready = Boolean(output) && !encoding;
  const button = $('primary');
  button.disabled = !ready;
  button.innerHTML = ready
    ? `${icon('download')}<span>ダウンロード（${FORMATS[output.format].label}・${formatBytes(output.blob.size)}）</span>`
    : '処理中…';
}

function notes() {
  const list = [];
  if (error) list.push({ kind: 'error', text: error });
  if (image.hasAlpha && !FORMATS[settings.format].alpha) {
    list.push({ kind: 'warn', text: '透明な部分は白になります。透明を残すならWebPかPNGを選んでください。' });
  }
  if (output && !encoding && output.blob.size >= image.file.size) {
    list.push({ kind: 'warn', text: '元のファイルより小さくなりませんでした。画質を下げるか、形式やサイズを変えてみてください。' });
  }
  if (settings.resize && !validSize(settings)) {
    list.push({ kind: 'error', text: `幅と高さは 1〜${MAX_SIDE} の整数で入力してください。` });
  }
  return list;
}

// ---------- controls

$('img-format').addEventListener('change', (e) => {
  settings.format = e.target.value;
  update();
});
$('img-quality').addEventListener('input', (e) => {
  settings.quality = Number(e.target.value);
  update();
});
$('img-resize').addEventListener('change', (e) => {
  settings.resize = e.target.checked;
  if (settings.resize && image && !validSize(settings)) Object.assign(settings, orientedSize());
  update();
});
$('img-width').addEventListener('input', (e) => {
  settings.width = Math.round(Number(e.target.value));
  matchRatio('width');
  update();
});
$('img-height').addEventListener('input', (e) => {
  settings.height = Math.round(Number(e.target.value));
  matchRatio('height');
  update();
});
$('img-keep-ratio').addEventListener('change', (e) => {
  settings.keepRatio = e.target.checked;
  matchRatio('width');
  update();
});
$('img-scales').addEventListener('click', (e) => {
  const factor = Number(e.target.closest('[data-scale]')?.dataset.scale);
  if (!factor || !image) return;
  const { width, height } = orientedSize();
  settings.width = Math.max(1, Math.round(width * factor));
  settings.height = Math.max(1, Math.round(height * factor));
  update();
});
