// HTML → Video generator.
//
//   od html-video generate --composition-dir <rel>
//        ↓ (route → this module)
//   HyperFrames renders the composition to MP4 bytes
//        ↓
//   bytes written to <projectsRoot>/<projectId>/<output>
//        ↓
//   FileViewer renders it.
//
// M1 renders a single HyperFrames composition directory (the same
// `hyperframes.json` + `meta.json` + `index.html` contract the media
// `hyperframes-html` model uses). The template library (M2), multi-scene
// storyboards (M3), and AI soundtrack (M4) build on this entrypoint.
//
// The render runs in the DAEMON process via the shared HyperFrames
// primitive (see media/hyperframes.ts for why). Generation is invoked
// asynchronously by the route and reuses the media task queue, so the
// returned metadata matches the media file-meta shape the task snapshot /
// CLI poll already understand.

import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureProject, kindFor, mimeFor, sanitizeName } from '../projects.js';
import {
  assertHyperFramesCompositionFile,
  renderHyperFramesComposition,
  type HyperFramesProgress,
} from '../media/hyperframes.js';

export { listHtmlVideoTemplates } from './templates.js';

export interface GenerateHtmlVideoArgs {
  projectRoot: string;
  projectsRoot: string;
  projectId: string;
  /** Project-relative composition directory (M1's only content source). */
  compositionDir?: string;
  /** Template id — reserved for M2; rejected with guidance until then. */
  template?: string;
  /** Output filename inside the project folder. Auto-named when omitted. */
  output?: string;
  /** Aspect ratio label, informational for the provider note. */
  aspect?: string;
  onProgress?: HyperFramesProgress;
}

export interface HtmlVideoFileMeta {
  name: string;
  size: number;
  mtime: number;
  kind: string;
  mime: string;
  model: string;
  surface: 'video';
  providerId: string;
  providerNote: string;
}

function autoOutputName(): string {
  return `html-video-${Date.now().toString(36)}.mp4`;
}

/**
 * Render an HTML composition to an MP4 in the project folder. Throws on any
 * validation or render failure (never falls back to a stub — this is a local
 * render, so a failure is a real failure the user must see).
 */
export async function generateHtmlVideo(
  args: GenerateHtmlVideoArgs,
): Promise<HtmlVideoFileMeta> {
  const { projectRoot, projectsRoot, projectId } = args;
  if (!projectRoot) throw new Error('projectRoot required');
  if (!projectsRoot) throw new Error('projectsRoot required');
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('projectId required');
  }

  if (args.template && !args.compositionDir) {
    throw new Error(
      'template rendering is not available yet (arrives with the html-video ' +
        'template library). For now pass --composition-dir pointing at a ' +
        'directory scaffolded with `npx hyperframes init`.',
    );
  }

  const compRel = args.compositionDir;
  if (typeof compRel !== 'string' || !compRel.trim()) {
    throw new Error(
      'html-video requires --composition-dir <project-relative-path> pointing ' +
        'at the directory scaffolded with hyperframes.json / meta.json / ' +
        'index.html. Run `npx hyperframes init "$OD_PROJECT_DIR/.hyperframes-cache/<id>" ' +
        '--example blank --skip-skills --non-interactive`, edit index.html, then ' +
        'pass that path here.',
    );
  }

  const dir = await ensureProject(projectsRoot, projectId);

  // Resolve compositionDir against the project dir and refuse anything that
  // escapes it — the agent has free file access to the project but the
  // dispatcher must not render an arbitrary directory on the host.
  const projectRootResolved = path.resolve(dir);
  const compAbs = path.resolve(projectRootResolved, compRel);
  if (
    compAbs !== projectRootResolved &&
    !compAbs.startsWith(projectRootResolved + path.sep)
  ) {
    throw new Error(
      `compositionDir "${compRel}" resolves outside the project directory. ` +
        'Pass a path relative to the project (e.g. ".hyperframes-cache/abc").',
    );
  }

  let compStat;
  try {
    compStat = await stat(compAbs);
  } catch {
    throw new Error(`compositionDir not found: ${compRel} (resolved to ${compAbs})`);
  }
  if (!compStat.isDirectory()) {
    throw new Error(`compositionDir is not a directory: ${compRel}`);
  }

  await assertHyperFramesCompositionFile(
    compAbs,
    compRel,
    'hyperframes.json',
    'Run `npx hyperframes init "$OD_PROJECT_DIR/$COMP_REL" --example blank --skip-skills --non-interactive` before editing the composition.',
  );
  await assertHyperFramesCompositionFile(
    compAbs,
    compRel,
    'meta.json',
    'Run `npx hyperframes init` so the renderer has duration/scene metadata before dispatch.',
  );
  await assertHyperFramesCompositionFile(
    compAbs,
    compRel,
    'index.html',
    'The agent must write index.html (with window.__timelines registration) before dispatch.',
  );

  let bytes: Buffer;
  try {
    bytes = await renderHyperFramesComposition(compAbs, args.onProgress);
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && typeof (err as { stderr?: unknown }).stderr === 'string'
        ? (err as { stderr: string }).stderr.trim()
        : '';
    const message = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`html-video render failed: ${message.slice(0, 480)}`);
  }

  const safeOut = sanitizeName(args.output || autoOutputName());
  const finalOut = safeOut.toLowerCase().endsWith('.mp4') ? safeOut : `${safeOut}.mp4`;
  const finalTarget = path.join(dir, finalOut);
  await writeFile(finalTarget, bytes);
  const st = await stat(finalTarget);
  const aspect = typeof args.aspect === 'string' && args.aspect ? args.aspect : '16:9';
  return {
    name: finalOut,
    size: st.size,
    mtime: st.mtimeMs,
    kind: kindFor(finalOut),
    mime: mimeFor(finalOut),
    model: 'hyperframes-html',
    surface: 'video',
    providerId: 'hyperframes',
    providerNote: `html-video/local-html · ${aspect} · ${st.size} bytes`,
  };
}
