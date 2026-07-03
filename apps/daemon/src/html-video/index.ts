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

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HtmlVideoScene } from '@open-design/contracts';
import { ensureProject, kindFor, mimeFor, sanitizeName } from '../projects.js';
import { resolveProviderConfig } from '../media/config.js';
import {
  assertHyperFramesCompositionFile,
  renderHyperFramesComposition,
  type HyperFramesProgress,
} from '../media/hyperframes.js';
import { buildCompositionFromTemplate, findHtmlVideoTemplate } from './templates.js';
import { concatVideos, mixAudioOntoVideo } from './ffmpeg.js';
import { synthesizeSpeech, type TtsProvider } from './tts.js';
import { buildStoryboardFromContent, fetchArticle, fetchRepo } from './extract.js';

export {
  listHtmlVideoTemplates,
  loadHtmlVideoTemplates,
  findHtmlVideoTemplate,
} from './templates.js';

export interface GenerateHtmlVideoArgs {
  projectRoot: string;
  projectsRoot: string;
  projectId: string;
  /** Project-relative composition directory (agent-authored path). */
  compositionDir?: string;
  /** Template id from the html-video catalogue. */
  template?: string;
  /** Slot values for the template's inputs. */
  inputs?: Record<string, string>;
  /** Ordered scenes for a multi-scene storyboard (rendered + concatenated). */
  scenes?: HtmlVideoScene[];
  /** Article URL to distill into a storyboard. */
  url?: string;
  /** GitHub repo (owner/repo or URL) to distill into a storyboard. */
  repo?: string;
  /** Cap on scenes generated from url/repo content (default 5). */
  maxScenes?: number;
  /** Design-template roots to resolve `template` against. */
  templateRoots?: string[];
  /** Narration text to synthesize and mix over the video. */
  narration?: string;
  /** TTS provider for narration (default: vbee). */
  ttsProvider?: TtsProvider | undefined;
  /** Provider voice id/code for narration. */
  voice?: string;
  /** Project-relative background-music file to mix (ducked under narration). */
  musicFile?: string;
  /** Background-music volume 0..1 (default 0.22). */
  musicVolume?: number;
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

  // Article / repo → storyboard: distill the source into scenes, then render.
  if (args.url || args.repo) {
    args.onProgress?.(args.repo ? `Reading repo ${args.repo}` : `Reading ${args.url}`);
    const content = args.repo
      ? await fetchRepo(args.repo)
      : await fetchArticle(args.url as string);
    const maxScenes = typeof args.maxScenes === 'number' ? args.maxScenes : undefined;
    const scenes = buildStoryboardFromContent(content, { maxScenes });
    args.onProgress?.(`Built ${scenes.length}-scene storyboard from source`);
    return renderStoryboard({ ...args, scenes });
  }

  // Multi-scene storyboard: render each scene to its own MP4, then concatenate.
  if (args.scenes && args.scenes.length > 0) {
    return renderStoryboard(args);
  }

  if (!args.template && !args.compositionDir) {
    throw new Error(
      'html-video requires --template <id> (see `od html-video templates`), ' +
        '--scenes <json> for a storyboard, --url/--repo to distill a source, ' +
        'or --composition-dir <project-relative-path>.',
    );
  }

  const dir = await ensureProject(projectsRoot, projectId);

  // Resolve the composition to render (`compAbs`) from one of two sources.
  // The template path builds a throwaway composition in an OS temp dir (cleaned
  // up after render); the compositionDir path renders an agent-authored dir
  // inside the project (path-guarded so it can't escape).
  let compAbs: string;
  let aspect = typeof args.aspect === 'string' && args.aspect ? args.aspect : '16:9';
  let cleanup: (() => Promise<void>) | null = null;

  if (args.template) {
    const template = findHtmlVideoTemplate(args.templateRoots ?? [], args.template);
    if (!template) {
      throw new Error(
        `unknown html-video template: "${args.template}". Run \`od html-video templates\` to list available ids.`,
      );
    }
    const tmpComp = await mkdtemp(path.join(os.tmpdir(), 'open-design-hv-'));
    cleanup = () => rm(tmpComp, { recursive: true, force: true });
    for (const file of buildCompositionFromTemplate(template, args.inputs ?? {})) {
      await mkdir(path.dirname(path.join(tmpComp, file.name)), { recursive: true });
      await writeFile(path.join(tmpComp, file.name), file.content, 'utf8');
    }
    compAbs = tmpComp;
    if (!(typeof args.aspect === 'string' && args.aspect)) {
      aspect = template.aspectRatios[0] || aspect;
    }
  } else {
    const compRel = args.compositionDir as string;
    // Resolve compositionDir against the project dir and refuse anything that
    // escapes it — the agent has free file access to the project but the
    // dispatcher must not render an arbitrary directory on the host.
    const projectRootResolved = path.resolve(dir);
    compAbs = path.resolve(projectRootResolved, compRel);
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
  }

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
  } finally {
    if (cleanup) await cleanup();
  }

  return finalizeWithSoundtrack(args, dir, bytes, aspect);
}

/** Write MP4 bytes into the project folder and build the file metadata. */
async function finalizeProjectVideo(
  dir: string,
  output: string | undefined,
  bytes: Buffer,
  aspect: string,
): Promise<HtmlVideoFileMeta> {
  const safeOut = sanitizeName(output || autoOutputName());
  const finalOut = safeOut.toLowerCase().endsWith('.mp4') ? safeOut : `${safeOut}.mp4`;
  const finalTarget = path.join(dir, finalOut);
  await writeFile(finalTarget, bytes);
  const st = await stat(finalTarget);
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

function describeRenderError(err: unknown): string {
  const stderr =
    err && typeof err === 'object' && typeof (err as { stderr?: unknown }).stderr === 'string'
      ? (err as { stderr: string }).stderr.trim()
      : '';
  return (stderr || (err instanceof Error ? err.message : String(err))).slice(0, 480);
}

/** Apply the soundtrack (narration + music) if requested, then write + describe. */
async function finalizeWithSoundtrack(
  args: GenerateHtmlVideoArgs,
  dir: string,
  bytes: Buffer,
  aspect: string,
): Promise<HtmlVideoFileMeta> {
  const withAudio = await applySoundtrack(args, dir, bytes);
  return finalizeProjectVideo(dir, args.output, withAudio, aspect);
}

/**
 * Synthesize narration and/or mix a background-music file onto the rendered
 * (silent) video. Returns the original bytes unchanged when no soundtrack was
 * requested. Runs entirely in an OS temp dir.
 */
async function applySoundtrack(
  args: GenerateHtmlVideoArgs,
  dir: string,
  videoBytes: Buffer,
): Promise<Buffer> {
  const wantsNarration = typeof args.narration === 'string' && args.narration.trim().length > 0;
  const wantsMusic = typeof args.musicFile === 'string' && args.musicFile.trim().length > 0;
  if (!wantsNarration && !wantsMusic) return videoBytes;

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'open-design-hv-au-'));
  try {
    const inPath = path.join(tmpRoot, 'in.mp4');
    await writeFile(inPath, videoBytes);

    let narrationPath: string | undefined;
    if (wantsNarration) {
      const provider: TtsProvider = args.ttsProvider === 'minimax' ? 'minimax' : 'vbee';
      const cfg = (await resolveProviderConfig(args.projectRoot, provider)) as {
        apiKey?: string;
        baseUrl?: string;
      };
      args.onProgress?.(`Synthesizing narration (${provider})`);
      const speech = await synthesizeSpeech({
        provider,
        text: args.narration as string,
        voice: args.voice,
        credentials: {
          apiKey: cfg?.apiKey,
          baseUrl: cfg?.baseUrl,
          appId: process.env.OD_VBEE_APP_ID,
          groupId: process.env.OD_MINIMAX_GROUP_ID,
        },
        onProgress: args.onProgress,
      });
      narrationPath = path.join(tmpRoot, `narration${speech.ext}`);
      await writeFile(narrationPath, speech.bytes);
    }

    let musicPath: string | undefined;
    if (wantsMusic) {
      musicPath = resolveProjectFile(dir, args.musicFile as string);
      try {
        const st = await stat(musicPath);
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        throw new Error(`music file not found in project: ${args.musicFile}`);
      }
    }

    const outPath = path.join(tmpRoot, 'out.mp4');
    args.onProgress?.('Mixing soundtrack');
    const mixOpts: Parameters<typeof mixAudioOntoVideo>[2] = {};
    if (narrationPath) mixOpts.narrationPath = narrationPath;
    if (musicPath) mixOpts.musicPath = musicPath;
    if (typeof args.musicVolume === 'number') mixOpts.musicVolume = args.musicVolume;
    await mixAudioOntoVideo(inPath, outPath, mixOpts, args.onProgress);
    return await readFile(outPath);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/** Resolve a project-relative file and refuse anything escaping the project. */
function resolveProjectFile(dir: string, rel: string): string {
  const root = path.resolve(dir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`"${rel}" resolves outside the project directory`);
  }
  return abs;
}

/**
 * Render an ordered storyboard: each scene renders to its own MP4 (reusing the
 * verified single-composition path), then ffmpeg concatenates them — scaling
 * every scene to the first scene's resolution so mixed templates still join.
 */
async function renderStoryboard(args: GenerateHtmlVideoArgs): Promise<HtmlVideoFileMeta> {
  const roots = args.templateRoots ?? [];
  const scenes = args.scenes ?? [];
  const resolved = scenes.map((scene, i) => {
    const template = findHtmlVideoTemplate(roots, scene.template);
    if (!template) {
      throw new Error(
        `unknown html-video template in scene ${i + 1}: "${scene.template}". Run \`od html-video templates\` to list available ids.`,
      );
    }
    return { scene, template };
  });
  if (resolved.length === 0) throw new Error('storyboard requires at least one scene');

  const first = resolved[0]!.template;
  const width = first.width;
  const height = first.height;
  const fps = first.fps && first.fps > 0 ? first.fps : 30;
  const aspect =
    typeof args.aspect === 'string' && args.aspect
      ? args.aspect
      : first.aspectRatios[0] || '16:9';

  const dir = await ensureProject(args.projectsRoot, args.projectId);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'open-design-hv-sb-'));
  try {
    const sceneVideos: string[] = [];
    for (let i = 0; i < resolved.length; i += 1) {
      const { scene, template } = resolved[i]!;
      args.onProgress?.(`Rendering scene ${i + 1}/${resolved.length} (${template.id})`);
      const compDir = path.join(tmpRoot, `scene-${i}`);
      await mkdir(compDir, { recursive: true });
      const buildOpts =
        typeof scene.durationSec === 'number' ? { durationSec: scene.durationSec } : {};
      for (const file of buildCompositionFromTemplate(template, scene.inputs ?? {}, buildOpts)) {
        await writeFile(path.join(compDir, file.name), file.content, 'utf8');
      }
      let bytes: Buffer;
      try {
        bytes = await renderHyperFramesComposition(compDir, args.onProgress);
      } catch (err) {
        throw new Error(`html-video scene ${i + 1} render failed: ${describeRenderError(err)}`);
      }
      const mp4 = path.join(tmpRoot, `scene-${i}.mp4`);
      await writeFile(mp4, bytes);
      sceneVideos.push(mp4);
    }

    if (sceneVideos.length === 1) {
      const bytes = await readFile(sceneVideos[0]!);
      return finalizeWithSoundtrack(args, dir, bytes, aspect);
    }

    args.onProgress?.(`Concatenating ${sceneVideos.length} scenes`);
    const concatOut = path.join(tmpRoot, 'storyboard.mp4');
    try {
      await concatVideos(sceneVideos, concatOut, { width, height, fps }, args.onProgress);
    } catch (err) {
      throw new Error(`html-video storyboard concat failed: ${describeRenderError(err)}`);
    }
    const bytes = await readFile(concatOut);
    return finalizeWithSoundtrack(args, dir, bytes, aspect);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
