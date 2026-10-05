// Video mode: the original on the left; on the right either a few seconds compressed at the
// playhead (a quick preview of the settings) or, once made, the whole compressed video.
import * as MB from 'mediabunny';
import * as view from './compare-view.js';
import { ComparePlayer } from './video-player.js';
import { SHORT_SIDES, fitShortSide, orientedSize, planVideo } from './video-plan.js';
import {
  $, UserError, baseName, clamp, downloadFile, errorMessage, formatBytes, formatFps, formatTime, icon, renderNotes,
  renderSummary, setFileHeader, toast,
} from './ui.js';

const PREVIEW_SECONDS = 4;
const CODEC_NAMES = { avc: 'H.264', hevc: 'H.265', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', prores: 'ProRes' };

/** What this browser can encode. Filled in by init(). */
export const encoders = { avc: false, hevc: false, aac: false, opus: false };

const settings = {
  mode: 'quality', preset: 'standard', targetMB: 25, resolution: 'auto', fps: 'auto', audio: 'keep', codec: 'avc', rotation: 0,
};
let video = null;         // the open file plus what analyze() found out about it
let showing = null;       // what the right side shows: 'preview' | 'result'
let preview = null;       // { start, end } of the current preview
let previewing = false;
let previewError = '';
let result = null;        // the whole video compressed: { blob, key, plan, retried, lostAudio }
let job = null;           // the running full compression
let message = null;       // how the last full compression ended, if not with a result
let seeking = false;      // the seek bar is being dragged
let session = 0;          // bumps on close, so late results for a closed file are dropped

const player = new ComparePlayer($('before-canvas'), $('after-canvas'), {
  onTime: renderTime,
  onPlayingChange: (playing) => {
    renderPlayButton(playing);
    if (!playing) previewIfUncovered();
  },
  onCoverageChange: renderAfterNotice,
});

/** Checks what the browser can encode. Throws a UserError when video compression is not possible. */
export async function init() {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new UserError('このブラウザは動画の圧縮に対応していません。動画は最新のChromeかEdgeで開いてください。画像の圧縮はこのまま使えます。');
  }
  const videoQuality = new MB.Quality({ bitrate: 2e6 });
  const audioQuality = new MB.Quality({ bitrate: 128e3 });
  const check = (promise) => promise.catch(() => false);
  [encoders.avc, encoders.hevc, encoders.aac, encoders.opus] = await Promise.all([
    check(MB.canEncodeVideo('avc', { width: 1280, height: 720, quality: videoQuality })),
    check(MB.canEncodeVideo('hevc', { width: 1280, height: 720, quality: videoQuality })),
    check(MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, quality: audioQuality })),
    check(MB.canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000, quality: audioQuality })),
  ]);
  if (!encoders.avc && !encoders.hevc) {
    throw new UserError('このブラウザ・端末では、MP4形式の動画を書き出せません。動画は最新のChromeかEdgeで開いてください。画像の圧縮はこのまま使えます。');
  }
  for (const option of $('video-codec').options) {
    if (!encoders[option.value]) {
      option.disabled = true;
      option.textContent += '（非対応）';
    }
  }
  if (!encoders.avc) settings.codec = 'hevc';
  $('video-codec').value = settings.codec;
  wireControls();
}

// ---------- editor interface

export async function open(file) {
  const id = ++session;
  const info = await analyze(file);
  if (id !== session) return;

  video = { file, ...info };
  settings.rotation = 0;
  $('video-settings').hidden = false;
  $('player').hidden = false;
  fillResolutionOptions();
  view.setSize(info.width, info.height);
  view.rotateOriginal($('before-canvas'), 0);
  player.setRange(info.start, info.end);
  $('seek').min = String(info.start);
  $('seek').max = String(info.end);
  renderMeta();
  renderTime(info.start);
  renderPlayButton(false);

  if (info.canDecode) {
    await player.load('before', file);
    if (id !== session) return;
  }
  updateAfterSide();
}

export async function close() {
  session++;
  await cancelPreview();
  await player.reset();
  video = null;
  showing = null;
  preview = null;
  previewError = '';
  result = null;
  message = null;
  view.rotateOriginal($('before-canvas'), 0);
  view.setAfterNotice('');
  for (const id of ['video-settings', 'player', 'progress', 'secondary', 'seek-preview']) $(id).hidden = true;
}

export function rotate() {
  if (!video || job) return;
  settings.rotation = (settings.rotation + 90) % 360;
  const { width, height } = orientedSize(video, settings.rotation);
  view.setSize(width, height);
  view.rotateOriginal($('before-canvas'), settings.rotation, video.width, video.height);
  fillResolutionOptions();
  renderMeta();
  updateAfterSide();
}

export function onPrimary() {
  if (isResultCurrent()) downloadResult();
  else startFull();
}

export function onKeyDown(e) {
  const actions = { ' ': togglePlay, ArrowLeft: () => stepFrame(-1), ArrowRight: () => stepFrame(1) };
  if (!video || !actions[e.key]) return;
  e.preventDefault();
  actions[e.key]();
}

export const isBusy = () => Boolean(job);

// ---------- reading a file

/** Reads what planning and playback need to know about a video file. */
async function analyze(file) {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new UserError('映像が入っていないファイルのようです。動画ファイルを選んでください。');
    const [end, first, width, height, codec, canDecode, color] = await Promise.all([
      input.computeDuration(),
      input.getFirstTimestamp(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getCodec(),
      track.canDecode(),
      track.getColorSpace().catch(() => null),
    ]);
    const start = Math.max(0, first);
    const duration = end - start;
    if (!(duration > 0)) throw new UserError('動画の長さを読み取れませんでした。ファイルが壊れていないか確認してください。');

    let audio = null;
    const audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack) {
      const stats = await audioTrack.computePacketStats(300).catch(() => null);
      audio = { codec: await audioTrack.getCodec(), bitrate: stats?.averageBitrate || 128e3 };
    }
    const totalBitrate = (file.size * 8) / duration;
    return {
      width,
      height,
      start,
      end,
      duration,
      codec,
      canDecode,
      audio,
      fps: await frameRate(track),
      size: file.size,
      videoBitrate: Math.max(totalBitrate - (audio?.bitrate ?? 0), totalBitrate * 0.5),
      hdr: color?.transfer === 'pq' || color?.transfer === 'hlg',
    };
  } catch (error) {
    if (error instanceof MB.UnsupportedInputFormatError) {
      throw new UserError(`「${file.name}」は読み込めない形式です。MP4・MOV・WebM・MKV の動画を選んでください。`);
    }
    throw error;
  } finally {
    input.dispose();
  }
}

async function frameRate(track) {
  try {
    return (await track.computeFrameRateMetrics()).bestGuessFrameRate || 30;
  } catch {
    const stats = await track.computePacketStats(120).catch(() => null);
    return stats?.averagePacketRate || 30;
  }
}

// ---------- compressing

function settingsKey() {
  return JSON.stringify(settings);
}

function currentPlan() {
  return planVideo(video, settings, encoders);
}

/** Whether the full result was made with the settings as they are now. */
function isResultCurrent() {
  return Boolean(result) && result.key === settingsKey();
}

/** Runs one conversion of the open file with `plan` and returns the MP4. */
async function compress(plan, { trim, onInit, onProgress } = {}) {
  const input = new MB.Input({ source: new MB.BlobSource(video.file), formats: MB.ALL_FORMATS });
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  try {
    const videoOptions = {
      codec: plan.codec,
      quality: new MB.Quality({ bitrate: plan.bitrate, bitrateMode: 'variable' }),
      forceTranscode: true,
      ...plan.resize,
    };
    if (plan.rotation) videoOptions.rotate = plan.rotation;
    if (plan.changeFps) videoOptions.frameRate = plan.fps;

    const conversion = await MB.Conversion.init({
      input,
      output,
      tracks: 'primary',
      trim,
      video: videoOptions,
      audio: audioOptions(plan.audio),
      showWarnings: false,
    });
    onInit?.(conversion);
    if (!conversion.isValid || !conversion.utilizedTracks.some((track) => track.type === 'video')) {
      throw new UserError(discardMessage(conversion.discardedTracks));
    }
    if (onProgress) conversion.onProgress = onProgress;
    await conversion.execute();
    return {
      blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
      lostAudio: conversion.discardedTracks.some((d) => d.track.type === 'audio' && d.reason !== 'discarded_by_user'),
    };
  } finally {
    input.dispose();
  }
}

function audioOptions(audio) {
  if (audio.kind === 'discard') return { discard: true };
  if (audio.kind === 'encode') return { codec: audio.codec, quality: new MB.Quality({ bitrate: audio.bitrate }) };
  return undefined; // copied as is, or there is none
}

function discardMessage(discarded) {
  switch (discarded.find((d) => d.track.type === 'video')?.reason) {
    case 'undecodable_source_codec':
      return 'このブラウザでは、この動画の形式を読み込めません。最新のChromeで開くか、別の形式で書き出した動画を選んでください。';
    case 'no_encodable_target_codec':
      return 'この解像度・形式では書き出せませんでした。解像度を下げるか、コーデックをH.264にしてください。';
    case 'unknown_source_codec':
      return '動画の形式を判別できませんでした。別の形式で書き出した動画を選んでください。';
    default:
      return '変換できませんでした。設定を変えてもう一度お試しください。';
  }
}

// ---------- the right side: preview or full result

/** Shows the whole compressed video if it matches the settings, otherwise makes a fresh preview. */
function updateAfterSide() {
  if (!video) return;
  if (isResultCurrent()) {
    if (showing !== 'result') {
      showing = 'result';
      cancelPreview();
      preview = null;
      previewError = '';
      player.load('after', result.blob, { offset: video.start });
    }
  } else if (video.canDecode) {
    showing = 'preview';
    previewing = true;
    schedulePreview();
  }
  render();
}

let previewTimer = 0;
let previewRun = 0;
let previewConversion = null;

function schedulePreview(delay = 450) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(makePreview, delay);
}

async function cancelPreview() {
  clearTimeout(previewTimer);
  previewRun++;
  previewing = false;
  const conversion = previewConversion;
  previewConversion = null;
  try { await conversion?.cancel(); } catch { /* already finished */ }
}

/** Compresses a few seconds from the playhead with the current settings and shows them on the right. */
async function makePreview() {
  if (!video || job || showing !== 'preview') return;
  const run = ++previewRun;
  const running = previewConversion;
  previewConversion = null;
  try { await running?.cancel(); } catch { /* already finished */ }
  if (run !== previewRun) return;

  const plan = currentPlan();
  if (plan.error) {
    previewing = false;
    previewError = '目標サイズを見直すと、ここにプレビューが出ます。';
    render();
    return;
  }
  const length = Math.min(PREVIEW_SECONDS, video.duration);
  const start = clamp(player.time, video.start, video.end - length);
  previewing = true;
  previewError = '';
  render();
  try {
    const { blob } = await compress(plan, {
      trim: { start, end: start + length },
      onInit: (conversion) => {
        if (run === previewRun) previewConversion = conversion;
        else conversion.cancel();
      },
    });
    if (run !== previewRun) return;
    await player.load('after', blob, { offset: start, window: [start, start + length] });
    if (run === previewRun) preview = { start, end: start + length };
  } catch (error) {
    if (run === previewRun && !(error instanceof MB.ConversionCanceledError)) {
      previewError = `プレビューを作れませんでした。${errorMessage(error)}`;
    }
  } finally {
    if (run === previewRun) {
      previewConversion = null;
      previewing = false;
      render();
    }
  }
}

/** After pausing or seeking outside the preview, makes a new preview at the playhead. */
function previewIfUncovered() {
  if (!video || showing !== 'preview' || player.playing || job || previewing) return;
  if (!player.after.covers(player.time)) schedulePreview(700);
}

// ---------- full compression

async function startFull() {
  if (job || !video) return;
  const plan = currentPlan();
  if (plan.error) return;
  const key = settingsKey();
  await cancelPreview();
  message = null;
  job = { conversion: null, cancelled: false, label: '動画全体を圧縮中…', passStartedAt: performance.now(), progress: 0, processed: 0 };
  setLocked(true);
  render();
  renderProgress();
  const clock = setInterval(renderProgress, 500); // keeps the remaining time moving between progress events
  const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);

  const onInit = (conversion) => {
    job.conversion = conversion;
    if (job.cancelled) conversion.cancel();
  };
  const onProgress = (progress, processed) => {
    job.progress = progress;
    job.processed = processed;
    scheduleProgress();
  };
  try {
    let used = plan;
    let output = await compress(plan, { onInit, onProgress });
    let retried = false;
    // Encoders don't hit a bitrate exactly. If the file came out over the target, try once more
    // with the video bitrate scaled down by how much it overshot.
    if (plan.target && output.blob.size > plan.target && !job.cancelled) {
      const audioBytes = (plan.audio.bitrate * video.duration) / 8;
      const ratio = (plan.target * 0.95 - audioBytes) / Math.max(1, output.blob.size - audioBytes);
      used = { ...plan, bitrate: Math.max(100e3, Math.round(plan.bitrate * Math.min(0.95, ratio))) };
      retried = true;
      Object.assign(job, { label: '目標サイズに合わせて再圧縮中…', passStartedAt: performance.now(), progress: 0, processed: 0 });
      output = await compress(used, { onInit, onProgress });
    }
    result = { blob: output.blob, key, plan: used, retried, lostAudio: output.lostAudio };
    showing = null;
    toast(`圧縮が完了しました（${formatBytes(video.size)} → ${formatBytes(output.blob.size)}）`);
  } catch (error) {
    message = job.cancelled || error instanceof MB.ConversionCanceledError
      ? { kind: 'info', text: '圧縮を中止しました。' }
      : { kind: 'error', text: errorMessage(error) };
  } finally {
    clearInterval(clock);
    wakeLock?.release().catch(() => {});
    job = null;
    setLocked(false);
    updateAfterSide();
  }
}

async function cancelFull() {
  if (!job) return;
  job.cancelled = true;
  job.label = '中止しています…';
  $('cancel').disabled = true;
  renderProgress();
  try { await job.conversion?.cancel(); } catch { /* already finished */ }
}

/** Keeps the settings, the back button and rotation still while compressing. */
function setLocked(locked) {
  $('video-settings').disabled = locked;
  $('back').disabled = locked;
  $('cancel').disabled = false;
  view.setRotateEnabled(!locked);
}

function downloadResult() {
  if (result) downloadFile(result.blob, `${baseName(video.file.name)}_compressed.mp4`);
}

// ---------- playback

function togglePlay() {
  if (player.playing) player.pause();
  else player.play();
}

function stepFrame(direction) {
  player.pause();
  player.seek(player.time + direction / (video.fps || 30));
  previewIfUncovered();
}

// ---------- rendering

function render() {
  if (!video) return;
  const plan = currentPlan();
  renderEstimates();
  renderNotes($('video-notes'), notes(plan));
  renderPreviewHint();
  renderFooter(plan);
  renderSeekPreview();
  renderAfterNotice();
}

function renderMeta() {
  const { width, height } = orientedSize(video, settings.rotation);
  setFileHeader({ meta: `${formatTime(video.duration)} · ${width} × ${height} · ${formatFps(video.fps)} · ${formatBytes(video.size)}` });
}

function fillResolutionOptions() {
  const { width, height } = orientedSize(video, settings.rotation);
  const options = [['auto', '自動'], ['source', `元のまま（${width}×${height}）`]];
  for (const side of SHORT_SIDES.filter((s) => s < Math.min(width, height))) {
    const size = fitShortSide(width, height, side);
    options.push([String(side), `${side}p（${size.width}×${size.height}）`]);
  }
  const select = $('video-resolution');
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  if (!options.some(([value]) => value === settings.resolution)) settings.resolution = 'auto';
  select.value = settings.resolution;
}

function renderEstimates() {
  for (const el of document.querySelectorAll('[data-preset]')) {
    const plan = planVideo(video, { ...settings, mode: 'quality', preset: el.dataset.preset }, encoders);
    el.textContent = plan.error ? '' : `約 ${formatBytes(plan.estimate)}\n${plan.width}×${plan.height}`;
  }
}

function notes(plan) {
  const list = [];
  if (!video.canDecode) {
    list.push({ kind: 'error', text: `このブラウザでは ${CODEC_NAMES[video.codec] ?? 'この形式'} の動画を読み込めません。最新のChromeで開くか、別の形式で書き出した動画を選んでください。` });
  }
  if (plan.error) list.push({ kind: 'error', text: plan.error });
  else list.push(...plan.notes);
  if (isResultCurrent()) {
    const size = result.blob.size;
    if (size >= video.size) {
      list.push({ kind: 'warn', text: '元の動画より小さくなりませんでした。「軽量」や「最小」を選ぶか、解像度を下げてください。' });
    }
    if (result.plan.target && size > result.plan.target) {
      list.push({ kind: 'warn', text: `目標より ${formatBytes(size - result.plan.target)} 大きくなりました。目標サイズを少し小さくして、もう一度お試しください。` });
    } else if (result.retried) {
      list.push({ kind: 'info', text: '1回目は目標を超えたので、ビットレートを下げて作り直しました。' });
    }
    if (result.lostAudio) list.push({ kind: 'warn', text: '音声はこのブラウザで変換できなかったため、入っていません。' });
  }
  if (message) list.push(message);
  return list;
}

function renderPreviewHint() {
  const range = preview && `${formatTime(preview.start - video.start)}〜${formatTime(preview.end - video.start)} の`;
  $('preview-hint').textContent = showing === 'result'
    ? '圧縮後は、動画全体を圧縮した結果です。'
    : `圧縮後は、${range || '再生位置から'}${PREVIEW_SECONDS}秒間だけを試しに圧縮したプレビューです。設定を変えると作り直します。`;
}

function renderFooter(plan) {
  const current = isResultCurrent();
  view.setLabels(`圧縮前 · ${formatBytes(video.size)}`, afterLabel());
  if (current) renderSummary(video.size, result.blob.size);
  else renderSummary(video.size, plan.error ? null : plan.estimate, { estimate: true });

  $('progress').hidden = !job;
  const button = $('primary');
  button.hidden = Boolean(job);
  if (current) {
    button.disabled = false;
    button.innerHTML = `${icon('download')}<span>ダウンロード（MP4・${formatBytes(result.blob.size)}）</span>`;
  } else {
    button.disabled = !video.canDecode || Boolean(plan.error) || !encoders[settings.codec];
    button.textContent = '動画全体を圧縮';
  }

  const secondary = $('secondary');
  secondary.hidden = Boolean(job) || !result || current;
  if (result) secondary.textContent = `前回の結果（${formatBytes(result.blob.size)}）をダウンロード`;
}

function afterLabel() {
  if (isResultCurrent()) return `圧縮後 · ${formatBytes(result.blob.size)}`;
  if (previewing) return '圧縮後 · 作成中…';
  return preview && !previewError ? '圧縮後 · プレビュー' : '圧縮後';
}

function renderSeekPreview() {
  const band = $('seek-preview');
  band.hidden = showing !== 'preview' || !preview;
  if (band.hidden) return;
  band.style.left = `${((preview.start - video.start) / video.duration) * 100}%`;
  band.style.width = `${((preview.end - preview.start) / video.duration) * 100}%`;
}

function renderAfterNotice() {
  view.setAfterNotice(afterNotice());
}

function afterNotice() {
  if (!video) return '';
  if (!video.canDecode) return 'この動画は、このブラウザでは表示できません。';
  if (showing === 'preview' && previewing) return 'プレビューを作成しています…';
  if (showing === 'preview' && previewError) return previewError;
  if (player.after.frames && !player.after.covers(player.time)) return 'この位置はまだプレビューしていません。一時停止すると作成します。';
  return '';
}

let progressQueued = 0;
function scheduleProgress() {
  progressQueued ||= setTimeout(() => {
    progressQueued = 0;
    renderProgress();
  }, 100);
}

function renderProgress() {
  if (!job) return;
  const seconds = (performance.now() - job.passStartedAt) / 1000;
  const percent = Math.min(100, Math.floor(job.progress * 100));
  $('progress-label').textContent = job.label;
  $('progress-percent').textContent = `${percent}%`;
  $('progress-fill').style.width = `${job.progress * 100}%`;
  $('progress-bar').setAttribute('aria-valuenow', String(percent));
  $('progress-eta').textContent = job.progress > 0.03 && seconds > 1
    ? `約 ${formatTime((seconds * (1 - job.progress)) / job.progress)}`
    : '計算中';
  $('progress-speed').textContent = seconds > 0.5 && job.processed > 0 ? `${(job.processed / seconds).toFixed(1)}倍速` : '—';
}

function renderTime(t) {
  if (!video) return;
  if (!seeking) $('seek').value = String(t);
  $('time').textContent = `${formatTime(t - video.start)} / ${formatTime(video.duration)}`;
}

function renderPlayButton(playing) {
  $('play-icon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play').setAttribute('aria-label', playing ? '一時停止' : '再生');
}

function renderTargetChips() {
  for (const chip of $('target-chips').querySelectorAll('[data-mb]')) {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.mb) === settings.targetMB));
  }
}

// ---------- controls

function wireControls() {
  const changed = () => {
    message = null;
    updateAfterSide();
  };
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      settings.mode = radio.value;
      $('quality-options').hidden = settings.mode !== 'quality';
      $('size-options').hidden = settings.mode !== 'size';
      changed();
    });
  }
  for (const radio of document.querySelectorAll('input[name="preset"]')) {
    radio.addEventListener('change', () => {
      settings.preset = radio.value;
      changed();
    });
  }
  $('target-size').addEventListener('input', (e) => {
    const value = Number(e.target.value);
    settings.targetMB = value > 0 ? value : NaN;
    renderTargetChips();
    changed();
  });
  $('target-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-mb]');
    if (!chip) return;
    settings.targetMB = Number(chip.dataset.mb);
    $('target-size').value = chip.dataset.mb;
    renderTargetChips();
    changed();
  });
  const selects = { 'video-resolution': 'resolution', 'video-fps': 'fps', 'video-codec': 'codec', 'video-audio': 'audio' };
  for (const [id, key] of Object.entries(selects)) {
    $(id).addEventListener('change', (e) => {
      settings[key] = e.target.value;
      changed();
    });
  }

  $('play').addEventListener('click', togglePlay);
  const seek = $('seek');
  seek.addEventListener('pointerdown', () => { seeking = true; });
  seek.addEventListener('pointerup', () => { seeking = false; });
  seek.addEventListener('input', () => player.seek(Number(seek.value)));
  seek.addEventListener('change', () => {
    seeking = false;
    previewIfUncovered();
  });
  $('audio-source').addEventListener('change', (e) => player.setListen(e.target.value));
  $('cancel').addEventListener('click', cancelFull);
  $('secondary').addEventListener('click', downloadResult);
  addEventListener('beforeunload', (e) => {
    if (job) e.preventDefault();
  });
  renderTargetChips();
}
