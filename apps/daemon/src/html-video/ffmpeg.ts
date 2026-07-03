// ffmpeg helpers for the html-video capability.
//
// HyperFrames renders one composition to one MP4. Multi-scene storyboards
// (M3) render each scene separately and concatenate them here; the AI
// soundtrack (M4) mixes audio onto the rendered video here too. Both run
// ffmpeg in the daemon process.
//
// ffmpeg resolution: OD_FFMPEG_PATH override → `ffmpeg` on PATH. The
// HyperFrames engine already requires ffmpeg to render, so a machine that can
// render at all has one; we surface a clear error if the spawn fails.

import { spawn } from 'node:child_process';

export const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

export function resolveFfmpeg(): string {
  const override = process.env.OD_FFMPEG_PATH;
  return typeof override === 'string' && override.trim() ? override.trim() : 'ffmpeg';
}

export type FfmpegProgress = (line: string) => void;

/** Run ffmpeg with the given args; reject on non-zero exit with the stderr tail. */
export function runFfmpeg(args: string[], onProgress?: FfmpegProgress): Promise<void> {
  const bin = resolveFfmpeg();
  return new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ['-hide_banner', '-y', ...args], {
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail += text;
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
      if (typeof onProgress === 'function') {
        for (const line of text.split(/[\r\n]+/)) {
          const trimmed = line.trim();
          if (trimmed) {
            try {
              onProgress(trimmed);
            } catch {
              // best-effort
            }
          }
        }
      }
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`ffmpeg timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 1000)}s`));
    }, FFMPEG_TIMEOUT_MS);

    child.on('error', (err: Error & { code?: string }) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `ffmpeg not found (tried "${bin}"). Install ffmpeg or set OD_FFMPEG_PATH to its full path.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      const tail = stderrTail.trim().split('\n').slice(-12).join('\n');
      const err = new Error(`ffmpeg ${reason}${tail ? `\n${tail}` : ''}`) as Error & {
        stderr: string;
      };
      err.stderr = tail;
      reject(err);
    });
  });
}

/**
 * Build the ffmpeg args that concatenate video-only clips into one MP4, scaling
 * and padding every clip to `width`x`height` so mixed resolutions/aspect ratios
 * still join cleanly. Exposed for unit testing the arg construction.
 */
export function buildConcatArgs(
  inputs: string[],
  output: string,
  opts: { width: number; height: number; fps?: number },
): string[] {
  const { width, height } = opts;
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
  const args: string[] = [];
  for (const input of inputs) args.push('-i', input);
  const scale = inputs
    .map(
      (_input, i) =>
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`,
    )
    .join(';');
  const concat =
    inputs.map((_input, i) => `[v${i}]`).join('') + `concat=n=${inputs.length}:v=1:a=0[v]`;
  args.push(
    '-filter_complex',
    `${scale};${concat}`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    output,
  );
  return args;
}

/** Concatenate video-only clips into one MP4. */
export async function concatVideos(
  inputs: string[],
  output: string,
  opts: { width: number; height: number; fps?: number },
  onProgress?: FfmpegProgress,
): Promise<void> {
  if (inputs.length === 0) throw new Error('concatVideos requires at least one input');
  await runFfmpeg(buildConcatArgs(inputs, output, opts), onProgress);
}

export interface SoundtrackArgs {
  /** Narration / voice-over audio, played at full volume. */
  narrationPath?: string;
  /** Background music, ducked under the narration. */
  musicPath?: string;
  /** Music volume 0..1 (default 0.22, i.e. ducked well under voice). */
  musicVolume?: number;
}

/**
 * Build ffmpeg args that mux a soundtrack onto a (silent) video. The video
 * length is preserved: audio is `apad`ded and `-shortest` trims at the video
 * end, so a short narration never cuts the video off. Exposed for testing.
 */
export function buildMixArgs(
  videoPath: string,
  output: string,
  soundtrack: SoundtrackArgs,
): string[] {
  const hasNarration = Boolean(soundtrack.narrationPath);
  const hasMusic = Boolean(soundtrack.musicPath);
  if (!hasNarration && !hasMusic) {
    throw new Error('buildMixArgs requires a narration or music track');
  }
  const vol = clampVolume(soundtrack.musicVolume);

  const args: string[] = ['-i', videoPath];
  if (hasNarration) args.push('-i', soundtrack.narrationPath as string);
  if (hasMusic) args.push('-i', soundtrack.musicPath as string);

  // Input indices: 0 = video; then narration (if any); then music (if any).
  const narrIdx = hasNarration ? 1 : -1;
  const musicIdx = hasMusic ? (hasNarration ? 2 : 1) : -1;

  let filter: string;
  if (hasNarration && hasMusic) {
    filter =
      `[${narrIdx}:a]apad[narr];` +
      `[${musicIdx}:a]volume=${vol},apad[mus];` +
      `[narr][mus]amix=inputs=2:duration=longest:normalize=0[a]`;
  } else if (hasNarration) {
    filter = `[${narrIdx}:a]apad[a]`;
  } else {
    filter = `[${musicIdx}:a]volume=${vol},apad[a]`;
  }

  args.push(
    '-filter_complex',
    filter,
    '-map',
    '0:v',
    '-map',
    '[a]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    output,
  );
  return args;
}

function clampVolume(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.22;
  return Math.min(1, Math.max(0, value));
}

/** Mux a narration and/or background-music track onto a silent video. */
export async function mixAudioOntoVideo(
  videoPath: string,
  output: string,
  soundtrack: SoundtrackArgs,
  onProgress?: FfmpegProgress,
): Promise<void> {
  await runFfmpeg(buildMixArgs(videoPath, output, soundtrack), onProgress);
}
