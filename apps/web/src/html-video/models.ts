/**
 * Web-side descriptor + client for the HTML → Video capability.
 *
 * Mirrors the media registry pattern (see ../media/models.ts): the daemon
 * owns generation, the web app owns discovery + the typed calls the UI makes.
 * M1 renders agent-scaffolded HyperFrames compositions; the template library
 * (the `templates` catalogue below) lands in a later milestone, so it is
 * currently empty but the shape is fixed by the contract.
 */

import type {
  HtmlVideoGenerateAccepted,
  HtmlVideoGenerateRequest,
  HtmlVideoTemplateSummary,
} from '@open-design/contracts';

export type { HtmlVideoTemplateSummary } from '@open-design/contracts';

/** Static descriptor the UI uses to label the capability. */
export const HTML_VIDEO_CAPABILITY = {
  id: 'html-video',
  label: 'HTML → Video',
  hint: 'Render an HTML composition into an MP4 locally (HyperFrames engine).',
  /** Local render — no API key required, always available. */
  credentialsRequired: false,
} as const;

/** Fetch the html-video template catalogue (empty until the library ships). */
export async function fetchHtmlVideoTemplates(
  search?: string,
): Promise<HtmlVideoTemplateSummary[]> {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const resp = await fetch(`/api/html-video/templates${qs}`, {
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`html-video templates ${resp.status}`);
  const data = (await resp.json()) as { templates?: HtmlVideoTemplateSummary[] };
  return Array.isArray(data.templates) ? data.templates : [];
}

/**
 * Queue an html-video render for a project. Returns the accepted task; poll
 * `/api/media/tasks/:id/wait` (the shared media task queue) for progress and
 * the final file, exactly like media generation.
 */
export async function generateHtmlVideo(
  projectId: string,
  body: HtmlVideoGenerateRequest,
): Promise<HtmlVideoGenerateAccepted> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/html-video/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`html-video generate ${resp.status}: ${text}`);
  }
  return (await resp.json()) as HtmlVideoGenerateAccepted;
}
