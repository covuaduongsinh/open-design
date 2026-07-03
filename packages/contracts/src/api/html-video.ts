// HTML → Video capability contract.
//
// The html-video capability renders an HTML composition (a directory holding
// `hyperframes.json` + `meta.json` + `index.html`) into an MP4 using the
// local HyperFrames engine. It is a dedicated, template-oriented surface that
// sits alongside `media` (which owns image/video/audio generation); both
// ultimately drive the same on-disk media task queue, so generation is
// accepted asynchronously and progress is polled through the shared
// `/api/media/tasks/:id/wait` endpoint.
//
// Pure TypeScript only — no Node/browser/daemon imports (see AGENTS.md).

/**
 * A template the html-video engine can render. Mirrors the license-clean
 * `template.*.yaml` metadata vendored under `design-templates/`. M1 ships an
 * empty catalogue; the shape is fixed here so the daemon, CLI, and web UI
 * agree on it before the library lands (M2).
 */
export interface HtmlVideoTemplateSummary {
  id: string;
  label: string;
  category: string;
  tags: string[];
  bestFor: string[];
  aspectRatios: string[];
  fps?: number;
  durationBoundsSec?: { min: number; max: number };
  hasAudioTrack?: boolean;
}

export interface HtmlVideoTemplatesResponse {
  templates: HtmlVideoTemplateSummary[];
}

/**
 * Body for `POST /api/projects/:id/html-video/generate` (local UI/CLI) and
 * `POST /api/tools/html-video/generate` (sandboxed agent, projectId derived
 * from the tool token). Exactly one content source must be supplied:
 * `compositionDir` (a project-relative directory the agent scaffolded) — M1.
 * `template` + `prompt` are reserved for the template library (M2+).
 */
export interface HtmlVideoGenerateRequest {
  /** Project-relative directory holding hyperframes.json / meta.json / index.html. */
  compositionDir?: string;
  /** Template id from the html-video catalogue. */
  template?: string;
  /** Slot values for the chosen template's inputs. */
  inputs?: Record<string, string>;
  /** Free-text brief used to fill template slots (M3+ storyboard). */
  prompt?: string;
  /** Output filename inside the project folder. Defaults to an auto name. */
  output?: string;
  /** Aspect ratio label, e.g. "16:9". Informational for M1. */
  aspect?: string;
}

/** 202 response: the task was queued. Poll `/api/media/tasks/:id/wait`. */
export interface HtmlVideoGenerateAccepted {
  taskId: string;
  status: string;
  startedAt: number;
}
