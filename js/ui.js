// Small helpers shared by the whole app: DOM access, formatting and common UI pieces.

export const $ = (id) => document.getElementById(id);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error whose message is written for the user and can be shown as is. */
export class UserError extends Error {}

export function errorMessage(error) {
  if (error instanceof UserError) return error.message;
  const detail = String(error?.message ?? error);
  if (/memory|allocation|array buffer/i.test(detail)) {
    return 'メモリが足りなくなりました。ほかのタブやアプリを閉じるか、解像度を下げてもう一度お試しください。';
  }
  return `途中で問題が起きました（${detail}）。設定を変えてもう一度お試しください。`;
}

// ---------- formatting

export function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatFps(fps) {
  const rounded = Math.round(fps);
  return `${Math.abs(fps - rounded) < 0.02 ? rounded : fps.toFixed(2)} fps`;
}

export const baseName = (fileName) => fileName.replace(/\.[^./\\]+$/, '') || 'file';

// ---------- UI pieces

export const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

/** Shows messages like `{ kind: 'info' | 'warn' | 'error', text }`; an empty list clears the container. */
export function renderNotes(container, notes) {
  container.replaceChildren(...notes.map(({ kind, text }) => {
    const note = document.createElement('p');
    note.className = `notice notice-${kind}`;
    note.innerHTML = icon(kind);
    note.append(Object.assign(document.createElement('span'), { textContent: text }));
    return note;
  }));
}

let toastTimer = 0;
export function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

export function setFileHeader({ kind, name, meta }) {
  if (kind) $('file-icon').setAttribute('href', `#i-${kind}`);
  if (name !== undefined) $('file-name').textContent = name;
  if (meta !== undefined) $('file-meta').textContent = meta;
}

/** The "before → after" box above the main button. `after` may be an estimate. */
export function renderSummary(before, after, { estimate = false } = {}) {
  $('sum-before').textContent = before ? formatBytes(before) : '—';
  $('sum-after-label').textContent = estimate ? '圧縮後（目安）' : '圧縮後';
  $('sum-after').textContent = after ? `${estimate ? '約 ' : ''}${formatBytes(after)}` : '—';

  const badge = $('sum-badge');
  const bar = $('sum-bar');
  if (!before || !after) {
    badge.textContent = '';
    bar.style.width = '0';
    return;
  }
  const saved = 1 - after / before;
  badge.textContent = saved > 0.005 ? `${Math.round(saved * 100)}% 削減`
    : saved < -0.005 ? `${Math.round(-saved * 100)}% 増加`
    : 'ほぼ同じ';
  badge.classList.toggle('is-bad', saved <= 0.005);
  bar.style.width = `${clamp((after / before) * 100, 1, 100)}%`;
}

export function downloadFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast(`ダウンロードを開始しました：${fileName}`);
}
