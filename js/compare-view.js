// The before/after canvas. Both sides share one transform (fit, zoom and pan), and the "after"
// layer is clipped at the divider, so dragging the divider reveals more of one side or the other.
import { $, clamp } from './ui.js';

const INSETS = { top: 48, right: 16, bottom: 60, left: 16 }; // keeps the labels and toolbar off the picture
const MAX_ZOOM = 32;

const stage = $('stage');
const contents = [$('before-content'), $('after-content')];
const phoneLayout = matchMedia('(max-width: 900px)');

// `zoom: null` means "fit to the stage".
const view = { width: 16, height: 9, split: 0.5, zoom: null, panX: 0, panY: 0, stageWidth: 1, stageHeight: 1 };

export function init({ onRotate, onKeyDown }) {
  wirePointer();
  wireKeyboard(onKeyDown);
  $('zoom-in').addEventListener('click', () => zoomTo(scale() * 1.25));
  $('zoom-out').addEventListener('click', () => zoomTo(scale() / 1.25));
  $('zoom-fit').addEventListener('click', fit);
  $('zoom-input').addEventListener('change', (e) => {
    const percent = Number(e.target.value);
    if (percent > 0) zoomTo(percent / 100); else render();
  });
  $('zoom-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('rotate').addEventListener('click', onRotate);
  new ResizeObserver(measure).observe(stage);
  addEventListener('resize', fitStageHeight);
}

export function setKind(kind) {
  stage.dataset.kind = kind;
  for (const side of ['before', 'after']) {
    $(`${side}-img`).hidden = kind !== 'image';
    $(`${side}-canvas`).hidden = kind !== 'video';
  }
}

/** Sets the size of the picture as displayed (after rotation) and fits it to the stage. */
export function setSize(width, height) {
  view.width = Math.max(1, width);
  view.height = Math.max(1, height);
  view.zoom = null;
  fitStageHeight();
  measure();
}

export function setLabels(before, after) {
  $('label-before').textContent = before;
  $('label-after').textContent = after;
}

/** A message over the "after" side, such as "making a preview". Empty text hides it. */
export function setAfterNotice(text) {
  $('after-notice').hidden = !text;
  $('after-notice-text').textContent = text;
}

export const setLoading = (loading) => { $('stage-loading').hidden = !loading; };
export const setRotateEnabled = (enabled) => { $('rotate').disabled = !enabled; };

/** The original is drawn unrotated at its own size, so it is turned inside the rotated content box. */
export function rotateOriginal(el, rotation, width, height) {
  const rotated = rotation !== 0;
  el.classList.toggle('is-rotated', rotated);
  el.style.width = rotated ? `${width}px` : '';
  el.style.height = rotated ? `${height}px` : '';
  el.style.transform = rotated ? `translate(-50%, -50%) rotate(${rotation}deg)` : '';
}

// ---------- transform

function fitScale() {
  return Math.max(0.01, Math.min(
    (view.stageWidth - INSETS.left - INSETS.right) / view.width,
    (view.stageHeight - INSETS.top - INSETS.bottom) / view.height,
  ));
}

function scale() {
  return view.zoom ?? fitScale();
}

/** Top-left corner of the picture when it is centered at scale `s`. */
function origin(s) {
  return {
    x: INSETS.left + (view.stageWidth - INSETS.left - INSETS.right - view.width * s) / 2,
    y: INSETS.top + (view.stageHeight - INSETS.top - INSETS.bottom - view.height * s) / 2,
  };
}

function render() {
  const s = scale();
  if (view.zoom === null) {
    view.panX = 0;
    view.panY = 0;
  } else {
    const maxX = Math.max(0, (view.width * s - view.stageWidth) / 2 + 40);
    const maxY = Math.max(0, (view.height * s - view.stageHeight) / 2 + 40);
    view.panX = clamp(view.panX, -maxX, maxX);
    view.panY = clamp(view.panY, -maxY, maxY);
  }
  const { x, y } = origin(s);
  for (const content of contents) {
    content.style.width = `${view.width}px`;
    content.style.height = `${view.height}px`;
    content.style.transform = `translate(${x + view.panX}px, ${y + view.panY}px) scale(${s})`;
  }

  const split = `${view.split * 100}%`;
  $('after-layer').style.clipPath = `inset(0 0 0 ${split})`;
  $('after-notice').style.left = split;
  $('divider').style.left = split;
  $('divider').setAttribute('aria-valuenow', String(Math.round(view.split * 100)));

  stage.classList.toggle('is-zoomed', s > fitScale() * 1.001);
  stage.classList.toggle('is-pixelated', s >= 3);
  if (document.activeElement !== $('zoom-input')) $('zoom-input').value = String(Math.round(s * 100));
}

/** Zooms around the stage point (cx, cy), keeping what is under it in place. */
function zoomTo(target, cx = view.stageWidth / 2, cy = view.stageHeight / 2) {
  const before = scale();
  const o = origin(before);
  const px = (cx - o.x - view.panX) / before;
  const py = (cy - o.y - view.panY) / before;

  const min = fitScale();
  const next = clamp(target, min, Math.max(MAX_ZOOM, min));
  view.zoom = next <= min * 1.001 ? null : next;

  const after = scale();
  const n = origin(after);
  view.panX = cx - px * after - n.x;
  view.panY = cy - py * after - n.y;
  render();
}

function fit() {
  view.zoom = null;
  render();
}

function measure() {
  view.stageWidth = stage.clientWidth || 1;
  view.stageHeight = stage.clientHeight || 1;
  render();
}

// On phones the canvas sits above the settings, so its height follows the picture's shape.
function fitStageHeight() {
  if (!phoneLayout.matches) {
    stage.style.height = '';
    return;
  }
  const width = stage.clientWidth || innerWidth;
  const wanted = ((width - INSETS.left - INSETS.right) * view.height) / view.width + INSETS.top + INSETS.bottom;
  stage.style.height = `${Math.round(clamp(wanted, 260, innerHeight * 0.62))}px`;
}

// ---------- input

function wirePointer() {
  const pointers = new Map();
  let gesture = null; // { type: 'split' } | { type: 'pan', ... } | { type: 'pinch', ... }

  const toStage = (x, y) => {
    const rect = stage.getBoundingClientRect();
    return [x - rect.left, y - rect.top];
  };
  const moveDivider = (clientX) => {
    const rect = stage.getBoundingClientRect();
    view.split = clamp((clientX - rect.left) / rect.width, 0, 1);
    render();
  };
  const startPan = (x, y) => ({ type: 'pan', x, y, panX: view.panX, panY: view.panY });

  stage.addEventListener('pointerdown', (e) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('.canvas-tools')) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = pointers.values();
      gesture = { type: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: scale() };
      return;
    }
    // Dragging anywhere moves the divider; once zoomed in, dragging the picture pans it instead.
    const onDivider = Boolean(e.target.closest('.divider'));
    if (onDivider || !stage.classList.contains('is-zoomed')) {
      gesture = { type: 'split' };
      moveDivider(e.clientX);
    } else {
      gesture = startPan(e.clientX, e.clientY);
      stage.classList.add('is-panning');
    }
    if (e.pointerType === 'mouse') {
      e.preventDefault();
      (onDivider ? $('divider') : stage).focus({ preventScroll: true });
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture?.type === 'split') {
      moveDivider(e.clientX);
    } else if (gesture?.type === 'pan') {
      view.panX = gesture.panX + e.clientX - gesture.x;
      view.panY = gesture.panY + e.clientY - gesture.y;
      render();
    } else if (gesture?.type === 'pinch' && pointers.size >= 2) {
      const [a, b] = pointers.values();
      const [cx, cy] = toStage((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomTo((gesture.scale * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.distance, cx, cy);
    }
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      gesture = null;
      stage.classList.remove('is-panning');
    } else if (gesture?.type === 'pinch') {
      const [rest] = pointers.values();
      gesture = startPan(rest.x, rest.y);
    }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  stage.addEventListener('wheel', (e) => {
    if (e.target.closest('.canvas-tools')) return;
    e.preventDefault();
    const [cx, cy] = toStage(e.clientX, e.clientY);
    const speed = e.ctrlKey ? 0.01 : 0.0022; // ctrlKey is set for trackpad pinches
    zoomTo(scale() * Math.exp(-e.deltaY * speed), cx, cy);
  }, { passive: false });

  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.divider, .canvas-tools')) return;
    const [cx, cy] = toStage(e.clientX, e.clientY);
    if (view.zoom === null) zoomTo(Math.max(1, fitScale() * 2), cx, cy); else fit();
  });
}

function wireKeyboard(onKeyDown) {
  $('divider').addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const next = { ArrowLeft: view.split - step, ArrowRight: view.split + step, Home: 0, End: 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    view.split = clamp(next, 0, 1);
    render();
  });

  const zoomKeys = {
    '+': () => zoomTo(scale() * 1.25),
    '=': () => zoomTo(scale() * 1.25),
    '-': () => zoomTo(scale() / 1.25),
    0: fit,
  };
  stage.addEventListener('keydown', (e) => {
    if (e.target !== stage) return;
    if (zoomKeys[e.key]) {
      e.preventDefault();
      zoomKeys[e.key]();
    } else {
      onKeyDown(e);
    }
  });
}
