// Chooses resolution, frame rate and bitrates for a video. Pure functions, no DOM access.
import { formatTime } from './ui.js';

// Bits per pixel per frame at the 720p reference; videoBitrate() adjusts them for size and frame rate.
export const PRESETS = {
  high: { maxShortSide: Infinity, bitsPerPixel: 0.1, maxFps: null },
  standard: { maxShortSide: 1080, bitsPerPixel: 0.075, maxFps: 30 },
  light: { maxShortSide: 720, bitsPerPixel: 0.065, maxFps: 30 },
  min: { maxShortSide: 480, bitsPerPixel: 0.055, maxFps: 30 },
};

/** Standard heights (the shorter side) offered when shrinking a video. */
export const SHORT_SIDES = [2160, 1440, 1080, 720, 540, 480, 360];

const REFERENCE_PIXELS = 1280 * 720;
const MIN_BITS_PER_PIXEL = 0.05; // in target-size mode, go down a resolution rather than below this
const MIN_VIDEO_BITRATE = 120e3;

const evenUp = (n) => Math.ceil(n / 2) * 2;

/** The video's size as displayed after turning it by `rotation` degrees. */
export const orientedSize = ({ width, height }, rotation) => (rotation % 180 ? { width: height, height: width } : { width, height });

/**
 * Scales the size so the shorter side is at most `maxShortSide`. Encoders need even sizes.
 * `resize` is the one side to pass to Mediabunny, which derives the other side the same way.
 */
export function fitShortSide(width, height, maxShortSide) {
  const shortSide = Math.min(width, height);
  const shrink = maxShortSide < shortSide;
  if (!shrink && width % 2 === 0 && height % 2 === 0) return { width, height, resize: {} };
  const side = evenUp(shrink ? maxShortSide : shortSide);
  return width >= height
    ? { width: evenUp(Math.round((side * width) / height)), height: side, resize: { height: side } }
    : { width: side, height: evenUp(Math.round((side * height) / width)), resize: { width: side } };
}

/**
 * Video bitrate for a picture size. Larger pictures need fewer bits per pixel, higher frame rates
 * need fewer bits per frame, and H.265 needs about a third less than H.264 for the same look.
 */
export function videoBitrate(width, height, fps, bitsPerPixel, codec) {
  const pixels = width * height;
  const sizeFactor = (REFERENCE_PIXELS / pixels) ** 0.15;
  const fpsFactor = (fps / 30) ** 0.7;
  const codecFactor = codec === 'hevc' ? 0.65 : 1;
  return pixels * 30 * fpsFactor * bitsPerPixel * sizeFactor * codecFactor;
}

const capFps = (fps, max) => (max && fps > max + 0.5 ? max : fps);

/** Copy the audio when it is already AAC (or nothing can encode it), otherwise re-encode it. */
function audioPlan(sourceAudio, setting, encoders) {
  if (!sourceAudio) return { kind: 'none', bitrate: 0 };
  if (setting === 'mute') return { kind: 'discard', bitrate: 0 };
  const codec = encoders.aac ? 'aac' : encoders.opus ? 'opus' : null;
  if (setting === 'low' && codec) return { kind: 'encode', codec, bitrate: 96e3 };
  if (sourceAudio.codec === 'aac' || !codec) return { kind: 'copy', bitrate: sourceAudio.bitrate };
  return { kind: 'encode', codec, bitrate: 128e3 };
}

/** The largest standard size that keeps enough bits per pixel at this bitrate. */
function autoSize(width, height, fps, bitrate, codec) {
  const shortSide = Math.min(width, height);
  for (const side of [Infinity, ...SHORT_SIDES.filter((s) => s < shortSide)]) {
    const size = fitShortSide(width, height, side);
    if (bitrate >= videoBitrate(size.width, size.height, fps, MIN_BITS_PER_PIXEL, codec)) return size;
  }
  return fitShortSide(width, height, SHORT_SIDES.at(-1));
}

/**
 * Works out how to compress a video. `info` describes the file (see analyze() in video-editor.js),
 * `settings` holds the user's choices, and `encoders` tells which audio encoders the browser has.
 * Returns `{ error }` when the settings cannot work.
 */
export function planVideo(info, settings, encoders) {
  const { mode, preset, targetMB, resolution, codec, rotation } = settings;
  const audio = audioPlan(info.audio, settings.audio, encoders);
  const pickFps = (auto) => (settings.fps === 'auto' ? auto : settings.fps === 'source' ? null : Number(settings.fps));
  const pickShortSide = (auto) => (resolution === 'auto' ? auto : resolution === 'source' ? Infinity : Number(resolution));
  const { width, height } = orientedSize(info, rotation);
  const notes = [];
  let size;
  let fps;
  let bitrate;
  let target = null;

  if (mode === 'quality') {
    const p = PRESETS[preset];
    size = fitShortSide(width, height, pickShortSide(p.maxShortSide));
    fps = capFps(info.fps, pickFps(p.maxFps));
    bitrate = videoBitrate(size.width, size.height, fps, p.bitsPerPixel, codec);
    if (bitrate > info.videoBitrate * 0.85) {
      bitrate = info.videoBitrate * 0.85;
      notes.push({ kind: 'info', text: '元の動画がすでに軽めなので、映像のビットレートは元の85%に抑えます。' });
    }
  } else {
    if (!(targetMB > 0)) return { error: '目標サイズを 1 MB 以上の数字で入力してください。' };
    target = targetMB * 1e6;
    fps = capFps(info.fps, pickFps(30));
    // Keep 4% for the container and for the encoder overshooting.
    bitrate = (target * 8 * 0.96 - audio.bitrate * info.duration) / info.duration;
    if (bitrate < MIN_VIDEO_BITRATE) {
      const neededMB = Math.ceil(((MIN_VIDEO_BITRATE + audio.bitrate) * info.duration) / 8 / 0.96 / 1e6);
      return { error: `この長さ（${formatTime(info.duration)}）だと、最低でも ${neededMB} MB ほど必要です。目標サイズを大きくするか、詳細設定で音声を軽く／なしにしてください。` };
    }
    size = resolution === 'auto'
      ? autoSize(width, height, fps, bitrate, codec)
      : fitShortSide(width, height, pickShortSide(Infinity));
    if (bitrate > info.videoBitrate * 0.9) {
      bitrate = info.videoBitrate * 0.9;
      notes.push({
        kind: 'info',
        text: info.size <= target
          ? 'この動画はすでに目標サイズ以下です。画質を保ったまま、少しだけ小さくします。'
          : '目標サイズに余裕があるので、映像のビットレートは元の90%にとどめます。',
      });
    }
  }

  if (info.hdr) notes.push({ kind: 'warn', text: 'HDR動画です。圧縮後は色が少し淡く見えることがあります。' });
  if (codec === 'hevc') notes.push({ kind: 'info', text: 'H.265は、古いWindows PCなどでは再生できないことがあります。迷ったらH.264を選んでください。' });

  bitrate = Math.max(Math.round(bitrate), 100e3);
  return {
    codec,
    rotation,
    width: size.width,
    height: size.height,
    resize: size.resize,
    fps,
    changeFps: Math.abs(fps - info.fps) > 0.01,
    bitrate,
    audio,
    target,
    estimate: (((bitrate + audio.bitrate) * info.duration) / 8) * 1.015, // + about 1.5% for the container
    notes,
  };
}
