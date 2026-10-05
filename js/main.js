// Entry point: the landing page, opening files, and switching between the image and video editors.
// Each editor module has the same interface: open(file), close(), rotate(), onPrimary(),
// onKeyDown(event) and isBusy().
import * as view from './compare-view.js';
import * as imageEditor from './image-editor.js';
import { makeSampleImage, makeSampleVideo } from './samples.js';
import { $, UserError, renderNotes, renderSummary, setFileHeader } from './ui.js';

const IMAGE_FILE = /\.(jpe?g|jfif|png|webp|avif|gif|bmp|ico|heic|heif)$/i;
const VIDEO_FILE = /\.(mp4|m4v|mov|qt|webm|mkv|ts|mts|m2ts|3gp)$/i;

// The video editor needs Mediabunny from a CDN, so it loads separately: if that fails, images still work.
const videoEditor = import('./video-editor.js').then(async (module) => {
  await module.init();
  return module;
});

let editor = null;  // the open editor module
let openCount = 0;  // lets a newer openFile() call win over an older one still loading

function kindOf(file) {
  if (file.type.startsWith('image/') || IMAGE_FILE.test(file.name)) return 'image';
  if (file.type.startsWith('video/') || VIDEO_FILE.test(file.name)) return 'video';
  return null;
}

const videoUnavailable = (error) => (error instanceof UserError
  ? error.message
  : '動画処理の準備ができませんでした。インターネットにつながっているか確認して、ページを再読み込みしてください。画像の圧縮はこのまま使えます。');

async function openFile(file, { name = file.name } = {}) {
  if (editor?.isBusy()) return;
  const kind = kindOf(file);
  if (!kind) {
    await showHomeError(`「${file.name}」は、画像や動画として読み込めない形式です。`);
    return;
  }

  const id = ++openCount;
  let next = imageEditor;
  if (kind === 'video') {
    try {
      next = await videoEditor;
    } catch (error) {
      await showHomeError(videoUnavailable(error));
      return;
    }
  }
  await closeEditor();
  if (id !== openCount) return;

  editor = next;
  showEditor(kind, name);
  try {
    await next.open(file);
    if (id === openCount) view.setLoading(false);
  } catch (error) {
    if (id !== openCount) return;
    await showHomeError(error instanceof UserError ? error.message : `「${file.name}」を読み込めませんでした（${error?.message ?? error}）。`);
  }
}

function showEditor(kind, name) {
  renderNotes($('home-notes'), []);
  $('home').hidden = true;
  $('editor').hidden = false;
  view.setKind(kind);
  view.setLabels('', '');
  view.setAfterNotice('');
  view.setLoading(true);
  view.setRotateEnabled(true);
  setFileHeader({ kind, name, meta: '' });
  renderSummary(null, null);
  $('primary').disabled = true;
  $('primary').textContent = kind === 'video' ? '動画全体を圧縮' : 'ダウンロード';
}

async function closeEditor() {
  const current = editor;
  editor = null;
  await current?.close();
}

async function goHome() {
  if (editor?.isBusy()) return;
  openCount++;
  await closeEditor();
  $('editor').hidden = true;
  $('home').hidden = false;
  scrollTo(0, 0);
}

async function showHomeError(text) {
  await goHome();
  renderNotes($('home-notes'), [{ kind: 'error', text }]);
}

// ---------- samples

async function openSampleImage() {
  const button = $('sample-image');
  button.disabled = true;
  try {
    await openFile(await makeSampleImage(), { name: 'サンプル画像' });
  } finally {
    button.disabled = false;
  }
}

async function openSampleVideo() {
  const button = $('sample-video');
  const label = $('sample-video-label');
  button.disabled = true;
  try {
    const { encoders } = await videoEditor;
    const file = await makeSampleVideo(encoders, (progress) => {
      label.textContent = `準備中 ${Math.round(progress * 100)}%`;
    });
    await openFile(file, { name: 'サンプル動画' });
  } catch (error) {
    await showHomeError(`サンプル動画を作れませんでした（${error?.message ?? error}）。`);
  } finally {
    label.textContent = '動画';
    button.disabled = false;
  }
}

// ---------- wiring

view.init({
  onRotate: () => editor?.rotate(),
  onKeyDown: (e) => editor?.onKeyDown(e),
});

const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, () => dropzone.classList.add('is-dragover'));
for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, () => dropzone.classList.remove('is-dragover'));

// Files can be dropped or pasted anywhere on the page, including onto the editor.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});
addEventListener('paste', (e) => {
  const file = e.clipboardData?.files[0];
  if (!file) return;
  e.preventDefault();
  openFile(file);
});

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) openFile(file);
});
$('sample-image').addEventListener('click', openSampleImage);
$('sample-video').addEventListener('click', openSampleVideo);
$('back').addEventListener('click', goHome);
$('primary').addEventListener('click', () => editor?.onPrimary());

videoEditor.then(
  () => { $('sample-video').disabled = false; },
  (error) => renderNotes($('video-support-notes'), [{ kind: 'warn', text: videoUnavailable(error) }]),
);
