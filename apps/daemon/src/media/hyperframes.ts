// Shared HyperFrames render primitive (heygen-com/hyperframes).
//
// Both the media dispatcher (`media/index.ts`, model `hyperframes-html`)
// and the dedicated HTML→video capability (`html-video/index.ts`) render
// the same way: a composition directory holding `hyperframes.json` +
// `meta.json` + `index.html` is handed to `npx hyperframes render`, which
// spawns a puppeteer-controlled Chrome to capture frames and ffmpeg to
// encode an MP4. Keeping the spawn/stream/cleanup logic here means the two
// callers can't drift.
//
// The render runs in the DAEMON process (not the agent's shell) because
// Claude Code's Bash tool wraps subprocesses in macOS sandbox-exec, under
// which Chrome hangs partway through frame capture. Output is pointed at a
// temp dir so HyperFrames' per-frame jpegs / intermediate compiled HTML
// stay OUT of the project folder — only the final MP4 bytes are returned.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type HyperFramesProgress = (line: string) => void;

export const HYPERFRAMES_RENDER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Assert a required composition file (hyperframes.json / meta.json /
 * index.html) exists. Throws a caller-friendly error with recovery
 * guidance when it does not — rendering against an incomplete
 * composition hangs HyperFrames for a while before failing, so we
 * short-circuit with a precise message instead.
 */
export async function assertHyperFramesCompositionFile(
  compAbs: string,
  compRel: string,
  fileName: string,
  guidance: string,
): Promise<void> {
  const fileStat = await stat(path.join(compAbs, fileName)).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    throw new Error(
      `compositionDir is missing ${fileName}: ${compRel}. ${guidance}`,
    );
  }
}

/**
 * Render a HyperFrames composition directory to MP4 bytes. The composition
 * is rendered into a throwaway temp dir which is deleted before returning,
 * so only the final MP4 buffer survives. `onProgress` receives every
 * ANSI-stripped stdout/stderr line for live UX.
 *
 * Throws on render failure; the thrown Error carries a `.stderr` tail so
 * callers can surface the real cause.
 */
export async function renderHyperFramesComposition(
  compAbs: string,
  onProgress?: HyperFramesProgress,
): Promise<Buffer> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'open-design-hf-'));
  const tmpOutput = path.join(tmpRoot, 'render.mp4');
  try {
    await runHyperFramesRender(compAbs, tmpOutput, onProgress);
    return await readFile(tmpOutput);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Run `npx hyperframes render` and stream every line of stdout/stderr
 * through `onProgress`. Resolves on a clean exit, rejects on non-zero
 * exit (with the stderr tail attached so the caller can surface it).
 *
 * Streaming matters for UX: the render typically takes 60–120s and
 * HF prints "Capturing frame N/M" as it goes. Without piping these
 * lines back to the caller, the HTTP request looks hung and the
 * agent's chat tool shows a long quiet spinner — users can't tell
 * whether anything is happening.
 */
export function runHyperFramesRender(
  compAbs: string,
  tmpOutput: string,
  onProgress?: HyperFramesProgress,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'npx',
      [
        '-y',
        'hyperframes',
        'render',
        compAbs,
        '--output',
        tmpOutput,
        '--workers',
        '1',
      ],
      {
        // Inherit env so npx can find the cached hyperframes install
        // and any user-level node config. stdin closed (HF doesn't
        // read from it), stdout/stderr piped so we can stream.
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // HF uses ANSI escape sequences (cursor moves, color codes, line
    // erases) for its pretty progress bar. Strip those before
    // forwarding so the agent's chat doesn't render a wall of `[2K`.
    // The regex covers CSI sequences (most of what HF emits).
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\[\?[0-9]+[hl]/g, '');

    const emit = (chunk: Buffer): void => {
      if (typeof onProgress !== 'function') return;
      const text = stripAnsi(chunk.toString('utf8'));
      // HF refreshes a single progress line many times per second; split
      // on \r and \n so each "Capturing frame X/Y" update reaches the
      // caller as its own line. Drop empty/duplicate lines so the
      // SSE stream stays compact.
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          onProgress(trimmed);
        } catch {
          // best-effort: never let an emitter throw kill the render
        }
      }
    };

    let stderrTail = '';
    child.stdout.on('data', emit);
    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
      emit(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(
        new Error(
          `hyperframes render timed out after ${Math.round(HYPERFRAMES_RENDER_TIMEOUT_MS / 1000)}s`,
        ),
      );
    }, HYPERFRAMES_RENDER_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      const tail = stderrTail.trim().split('\n').slice(-12).join('\n');
      const err = new Error(
        `hyperframes render exited ${reason}` + (tail ? `\n${tail}` : ''),
      ) as Error & { stderr: string };
      err.stderr = tail;
      reject(err);
    });
  });
}
