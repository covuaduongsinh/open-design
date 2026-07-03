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
