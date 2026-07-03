// HTML → Video template catalogue + loader.
//
// Templates live under `<design-templates>/html-video/<id>/` as a pair:
//   - template.json  — metadata + slot ("inputs") definitions
//   - index.html     — a HyperFrames single-composition body with `{{slot}}`
//                      placeholders
// The design-templates SKILL scanner only descends into immediate children of
// a root that contain a `SKILL.md`, so the `html-video/` container (which has
// none) is safely ignored by it; this module owns the subtree instead.
//
// A template is rendered by substituting its slots and wrapping the result in
// a throwaway HyperFrames composition (hyperframes.json + meta.json), which
// the shared render primitive then turns into an MP4.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { HtmlVideoTemplateSummary } from '@open-design/contracts';

export interface HtmlVideoTemplateInput {
  label: string;
  default: string;
  /** Slot kind — 'text' is HTML-escaped, 'color' is validated as a CSS color. */
  kind?: 'text' | 'color';
}

export interface HtmlVideoTemplate extends HtmlVideoTemplateSummary {
  /** Absolute directory the template was loaded from. */
  dir: string;
  durationSec: number;
  width: number;
  height: number;
  inputs: Record<string, HtmlVideoTemplateInput>;
}

const SUBDIR = 'html-video';

function summarize(t: HtmlVideoTemplate): HtmlVideoTemplateSummary {
  const summary: HtmlVideoTemplateSummary = {
    id: t.id,
    label: t.label,
    category: t.category,
    tags: t.tags,
    bestFor: t.bestFor,
    aspectRatios: t.aspectRatios,
  };
  if (typeof t.fps === 'number') summary.fps = t.fps;
  if (t.durationBoundsSec) summary.durationBoundsSec = t.durationBoundsSec;
  if (typeof t.hasAudioTrack === 'boolean') summary.hasAudioTrack = t.hasAudioTrack;
  return summary;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function parseTemplate(dir: string, raw: string): HtmlVideoTemplate | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || typeof data.id !== 'string') return null;

  const inputs: Record<string, HtmlVideoTemplateInput> = {};
  if (data.inputs && typeof data.inputs === 'object') {
    for (const [key, val] of Object.entries(data.inputs as Record<string, any>)) {
      if (!val || typeof val !== 'object') continue;
      inputs[key] = {
        label: typeof val.label === 'string' ? val.label : key,
        default: typeof val.default === 'string' ? val.default : '',
        kind: val.kind === 'color' ? 'color' : 'text',
      };
    }
  }

  const template: HtmlVideoTemplate = {
    id: data.id,
    label: typeof data.label === 'string' ? data.label : data.id,
    category: typeof data.category === 'string' ? data.category : 'other',
    tags: asStringArray(data.tags),
    bestFor: asStringArray(data.bestFor),
    aspectRatios: asStringArray(data.aspectRatios).length
      ? asStringArray(data.aspectRatios)
      : ['16:9'],
    dir,
    durationSec:
      typeof data.durationSec === 'number' && data.durationSec > 0 ? data.durationSec : 5,
    width: typeof data.width === 'number' && data.width > 0 ? data.width : 1920,
    height: typeof data.height === 'number' && data.height > 0 ? data.height : 1080,
    inputs,
  };
  if (typeof data.fps === 'number') template.fps = data.fps;
  if (
    data.durationBoundsSec &&
    typeof data.durationBoundsSec.min === 'number' &&
    typeof data.durationBoundsSec.max === 'number'
  ) {
    template.durationBoundsSec = {
      min: data.durationBoundsSec.min,
      max: data.durationBoundsSec.max,
    };
  }
  if (typeof data.hasAudioTrack === 'boolean') template.hasAudioTrack = data.hasAudioTrack;
  return template;
}

/**
 * Load every html-video template found under the given design-template roots.
 * Earlier roots win on id collision (so a user copy shadows the built-in).
 */
export function loadHtmlVideoTemplates(roots: string[]): HtmlVideoTemplate[] {
  const byId = new Map<string, HtmlVideoTemplate>();
  for (const root of roots) {
    if (!root) continue;
    const base = path.join(root, SUBDIR);
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(base, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const metaPath = path.join(dir, 'template.json');
        const htmlPath = path.join(dir, 'index.html');
        if (!statSync(metaPath).isFile() || !statSync(htmlPath).isFile()) continue;
        const template = parseTemplate(dir, readFileSync(metaPath, 'utf8'));
        if (!template) continue;
        if (!byId.has(template.id)) byId.set(template.id, template);
      } catch {
        continue;
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** Rank templates by how well they match a free-text intent. */
function rank(template: HtmlVideoTemplate, terms: string[]): number {
  if (terms.length === 0) return 1;
  const haystack = [
    template.id,
    template.label,
    template.category,
    ...template.tags,
    ...template.bestFor,
  ]
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
}

export function listHtmlVideoTemplates(
  roots: string[],
  search?: string,
): HtmlVideoTemplateSummary[] {
  const all = loadHtmlVideoTemplates(roots);
  const terms = (search ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return all.map(summarize);
  return all
    .map((t) => ({ t, score: rank(t, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => summarize(x.t));
}

export function findHtmlVideoTemplate(
  roots: string[],
  id: string,
): HtmlVideoTemplate | null {
  return loadHtmlVideoTemplates(roots).find((t) => t.id === id) ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Accept only safe CSS color tokens for `color` slots — a hex color or a
// conservative named/functional subset — so a slot value can never break out
// of a style attribute or inject arbitrary CSS.
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/;

/**
 * Substitute a template's `{{slot}}` placeholders. Text slots are HTML-escaped;
 * color slots are validated (falling back to the default on anything unsafe);
 * `{{duration}}` / `{{width}}` / `{{height}}` resolve from the template.
 */
export function renderTemplateHtml(
  template: HtmlVideoTemplate,
  inputs: Record<string, string> = {},
  opts: { durationSec?: number } = {},
): string {
  const durationSec =
    typeof opts.durationSec === 'number' && opts.durationSec > 0
      ? opts.durationSec
      : template.durationSec;
  const values: Record<string, string> = {
    duration: String(durationSec),
    width: String(template.width),
    height: String(template.height),
  };
  for (const [key, def] of Object.entries(template.inputs)) {
    const raw = typeof inputs[key] === 'string' ? inputs[key] : def.default;
    if (def.kind === 'color') {
      values[key] = SAFE_COLOR.test(raw.trim()) ? raw.trim() : def.default;
    } else {
      values[key] = escapeHtml(raw);
    }
  }
  const html = readFileSync(path.join(template.dir, 'index.html'), 'utf8');
  return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    values[key] ?? '',
  );
}

/**
 * Build the three composition files for a template render. Pure: callers write
 * them into a temp composition dir before invoking the render primitive.
 */
export function buildCompositionFromTemplate(
  template: HtmlVideoTemplate,
  inputs: Record<string, string> = {},
  opts: { durationSec?: number } = {},
): { name: string; content: string }[] {
  const hyperframes = {
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    registry:
      'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry',
    paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
  };
  const meta = { id: template.id, name: template.label };
  return [
    { name: 'hyperframes.json', content: JSON.stringify(hyperframes, null, 2) },
    { name: 'meta.json', content: JSON.stringify(meta, null, 2) },
    { name: 'index.html', content: renderTemplateHtml(template, inputs, opts) },
  ];
}
