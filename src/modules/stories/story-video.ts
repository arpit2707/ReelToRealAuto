import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { STORY_HEIGHT, STORY_WIDTH } from './story-image';

export const REEL_SECONDS = 7;
const FPS = 30;
const ENCODE_TIMEOUT_MS = 120_000;

/**
 * Turns a 9:16 post image into a short Reel: a slow Ken Burns zoom towards the
 * centre, H.264 + AAC, which is what Instagram's Reels API accepts.
 *
 * Instagram's trending sounds cannot be attached through the API, so the audio
 * is either a track the business is licensed to use (REEL_AUDIO_PATH) or
 * silence. A silent track is still included because some players and the
 * Reels processor handle "no audio stream" worse than "quiet audio".
 */
export async function toReelMp4(image: Buffer, audioPath = process.env.REEL_AUDIO_PATH): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r2r-reel-'));
  const input = path.join(dir, 'in.jpg');
  const output = path.join(dir, 'out.mp4');
  try {
    await fs.writeFile(input, image);
    const frames = REEL_SECONDS * FPS;
    const audio = audioPath && (await exists(audioPath))
      ? ['-stream_loop', '-1', '-i', audioPath]
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
    // Upscale first: zoompan works on whole pixels, and zooming a 1080p frame
    // directly makes the picture visibly jitter.
    const video =
      `[0:v]scale=${STORY_WIDTH * 2}:${STORY_HEIGHT * 2},` +
      `zoompan=z='min(zoom+0.0006,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
      `:d=${frames}:s=${STORY_WIDTH}x${STORY_HEIGHT}:fps=${FPS},format=yuv420p[v]`;
    await run(ffmpegPath(), [
      '-y',
      '-loop', '1',
      '-i', input,
      ...audio,
      '-filter_complex', video,
      '-map', '[v]',
      '-map', '1:a',
      '-t', String(REEL_SECONDS),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'high',
      '-crf', '23',
      '-r', String(FPS),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-shortest',
      // Metadata up front, so Instagram can start processing while downloading.
      '-movflags', '+faststart',
      output,
    ]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bundled: string | null = require('ffmpeg-static');
  const bin = process.env.FFMPEG_PATH || bundled;
  if (!bin) throw new Error('ffmpeg is not available on this server');
  return bin;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Reel video took too long to make'));
    }, ENCODE_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Reel video failed (ffmpeg ${code}): ${stderr.trim().split('\n').pop()}`));
    });
  });
}

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}
