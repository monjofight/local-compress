// Sample files drawn in the browser, so the tool can be tried without picking a file.

const FONT = '"Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';

let sampleImage = null;

/** A 1600×1000 PNG landscape with gradients, fine lines and grain, where compression shows. */
export async function makeSampleImage() {
  if (!sampleImage) {
    const canvas = new OffscreenCanvas(1600, 1000);
    drawLandscape(canvas.getContext('2d'), canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    sampleImage = new File([blob], 'sample.png', { type: 'image/png' });
  }
  return sampleImage;
}

/**
 * An 8-second 1080p MP4 with moving shapes, grain, a running clock and a beep every second,
 * made with the browser's own encoder. `encoders` comes from the video editor.
 */
export async function makeSampleVideo(encoders, onProgress) {
  const MB = await import('mediabunny');
  const width = 1920;
  const height = 1080;
  const fps = 30;
  const seconds = 8;

  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  const grainCtx = new OffscreenCanvas(640, 108).getContext('2d');
  const grain = { ctx: grainCtx, image: grainCtx.createImageData(640, 108) };

  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  const video = new MB.CanvasSource(canvas, { codec: encoders.avc ? 'avc' : 'hevc', quality: new MB.Quality({ bitrate: 20e6 }) });
  output.addVideoTrack(video, { frameRate: fps });
  const audioCodec = encoders.aac ? 'aac' : encoders.opus ? 'opus' : null;
  const audio = audioCodec ? new MB.AudioBufferSource({ codec: audioCodec, quality: new MB.Quality({ bitrate: 128e3 }) }) : null;
  if (audio) output.addAudioTrack(audio);

  await output.start();
  if (audio) await audio.add(beeps(seconds));
  const frames = fps * seconds;
  for (let i = 0; i < frames; i++) {
    drawClipFrame(ctx, width, height, i / fps, grain);
    await video.add(i / fps, 1 / fps);
    if (i % 8 === 0) onProgress(i / frames);
  }
  await output.finalize();
  return new File([output.target.buffer], 'sample-video.mp4', { type: 'video/mp4' });
}

function drawLandscape(ctx, width, height) {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#1f4e79');
  sky.addColorStop(0.5, '#e9a46a');
  sky.addColorStop(0.72, '#f6d39c');
  sky.addColorStop(1, '#2a2438');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const sun = ctx.createRadialGradient(1120, 560, 10, 1120, 560, 260);
  sun.addColorStop(0, 'rgba(255, 244, 214, 1)');
  sun.addColorStop(0.25, 'rgba(255, 214, 150, 0.9)');
  sun.addColorStop(1, 'rgba(255, 190, 120, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(800, 260, 640, 600);

  const ridge = (y, amplitude, color, seed) => {
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += 8) {
      const wave = Math.sin(x / 140 + seed) + Math.sin(x / 47 + seed * 2) * 0.35 + Math.sin(x / 13 + seed) * 0.08;
      ctx.lineTo(x, y + wave * amplitude);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  ridge(650, 46, '#6a4f6b', 1);
  ridge(720, 38, '#3d3550', 2.3);
  ridge(800, 30, '#211d2e', 4.1);

  // Grain on the foreground and thin lines in the sky: details that lossy compression smears first.
  const ground = ctx.getImageData(0, 760, width, height - 760);
  for (let i = 0; i < ground.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 34;
    ground.data[i] += noise;
    ground.data[i + 1] += noise;
    ground.data[i + 2] += noise;
  }
  ctx.putImageData(ground, 0, 760);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 40; i++) {
    ctx.beginPath();
    ctx.moveTo(80 + i * 9, 300);
    ctx.lineTo(200 + i * 9, 560);
    ctx.stroke();
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = `700 84px ${FONT}`;
  ctx.fillText('Sample Photo', 80, 190);
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText('スライダーを動かして、圧縮前と圧縮後を見比べてください', 84, 250);
  ctx.font = `400 16px ${FONT}`;
  ctx.fillText('細い線や文字、空のグラデーションは、画質を下げると違いが出やすい部分です。', 84, 640);
}

function drawClipFrame(ctx, width, height, t, grain) {
  const sky = ctx.createLinearGradient(0, 0, width, height);
  sky.addColorStop(0, '#1e3a8a');
  sky.addColorStop(0.5, '#0ea5e9');
  sky.addColorStop(1, '#a7f3d0');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  for (let k = 0; k < 6; k++) {
    const x = (((k * 0.19 + t * 0.06) % 1.2) - 0.1) * width;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.1 + k * 0.03})`;
    ctx.beginPath();
    ctx.arc(x, height * (0.25 + 0.1 * k), height * (0.08 + 0.02 * k), 0, Math.PI * 2);
    ctx.fill();
  }

  // Fresh noise every frame is the hardest thing for a video encoder.
  const { data } = grain.image;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = Math.random() * 255;
    data[i + 3] = 60;
  }
  grain.ctx.putImageData(grain.image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(grain.ctx.canvas, 0, height * 0.7, width, height * 0.3);

  const ballX = width * (0.1 + 0.8 * (0.5 - 0.5 * Math.cos(t * Math.PI * 0.5)));
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(ballX, height * 0.5, height * 0.06, 0, Math.PI * 2);
  ctx.fill();

  // A clock in each frame makes it easy to check that both sides show the same moment.
  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
  ctx.fillRect(width * 0.36, height * 0.78, width * 0.28, height * 0.12);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(height * 0.07)}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${t.toFixed(2)} 秒`, width / 2, height * 0.84);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/** A short 1 kHz beep at the start of every second. */
function beeps(seconds) {
  const sampleRate = 48000;
  const buffer = new AudioBuffer({ length: sampleRate * seconds, numberOfChannels: 2, sampleRate });
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      data[i] = t % 1 < 0.15 ? 0.18 * Math.sin(2 * Math.PI * 1000 * t) : 0;
    }
  }
  return buffer;
}
