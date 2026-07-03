// Article / repo → storyboard extraction for the html-video capability.
//
// Fetches an article URL or a GitHub repo, distills it into a small set of
// text blocks, and maps those onto html-video templates to produce a
// storyboard (HtmlVideoScene[]). Network fetches go through the SSRF-hardened
// `assertAndFetchExternalAsset`. The HTML→blocks and blocks→scenes steps are
// pure so they can be unit-tested without network access.

import type { HtmlVideoScene } from '@open-design/contracts';
import { assertAndFetchExternalAsset } from '../connectionTest.js';

export interface ContentBlock {
  type: 'heading' | 'text';
  text: string;
}

export interface ExtractedContent {
  title: string;
  subtitle: string;
  blocks: ContentBlock[];
}

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'OpenDesignHtmlVideo/1.0 (+https://github.com/nexu-io/open-design)';

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract a title, subtitle, and ordered heading/text blocks from raw HTML. */
export function extractArticleFromHtml(html: string, sourceUrl: string): ExtractedContent {
  // Drop non-content regions before scanning for text.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');

  const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(cleaned);
  const title = stripTags(
    (ogTitle && ogTitle[1]) || (h1 && h1[1]) || (titleTag && titleTag[1]) || 'Untitled',
  );

  let host = '';
  try {
    host = new URL(sourceUrl).host;
  } catch {
    host = '';
  }

  const blocks: ContentBlock[] = [];
  const blockRe = /<(h[1-3]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(cleaned)) !== null) {
    const tag = match[1]!.toLowerCase();
    const text = stripTags(match[2]!);
    if (!text || text.length < 3) continue;
    blocks.push({ type: tag.startsWith('h') ? 'heading' : 'text', text });
  }

  return { title, subtitle: host, blocks };
}

/** Fetch an article URL and extract its content (SSRF-guarded). */
export async function fetchArticle(url: string): Promise<ExtractedContent> {
  const resp = await assertAndFetchExternalAsset(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} for ${url}`);
  const html = await resp.text();
  return extractArticleFromHtml(html, url);
}

/** Parse an owner/repo reference from a slug or a github.com URL. */
export function parseRepoRef(ref: string): { owner: string; repo: string } | null {
  const trimmed = ref.trim();
  const urlMatch = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(trimmed);
  if (urlMatch) return { owner: urlMatch[1]!, repo: urlMatch[2]!.replace(/\.git$/, '') };
  const slug = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(trimmed);
  if (slug) return { owner: slug[1]!, repo: slug[2]!.replace(/\.git$/, '') };
  return null;
}

/** Fetch a GitHub repo's metadata + README and extract its content. */
export async function fetchRepo(ref: string): Promise<ExtractedContent> {
  const parsed = parseRepoRef(ref);
  if (!parsed) throw new Error(`not a github repo reference: ${ref}`);
  const { owner, repo } = parsed;
  const apiHeaders = {
    'user-agent': USER_AGENT,
    accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };

  const metaResp = await assertAndFetchExternalAsset(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { headers: apiHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!metaResp.ok) throw new Error(`github repo fetch failed: ${metaResp.status} for ${owner}/${repo}`);
  const meta: any = await metaResp.json();

  const blocks: ContentBlock[] = [];
  if (meta.description) blocks.push({ type: 'text', text: String(meta.description) });
  if (typeof meta.stargazers_count === 'number') {
    blocks.push({ type: 'heading', text: `${meta.stargazers_count.toLocaleString('en-US')} stars` });
  }
  if (meta.language) blocks.push({ type: 'text', text: `Built with ${meta.language}` });

  // README (best-effort — a repo without one still yields a title card).
  try {
    const readmeResp = await assertAndFetchExternalAsset(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      {
        headers: { ...apiHeaders, accept: 'application/vnd.github.raw' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (readmeResp.ok) {
      const readme = await readmeResp.text();
      for (const block of extractMarkdownBlocks(readme)) blocks.push(block);
    }
  } catch {
    // ignore README failures
  }

  return { title: meta.full_name || `${owner}/${repo}`, subtitle: 'github.com', blocks };
}

/** Extract heading/text blocks from Markdown (headings and paragraphs). */
export function extractMarkdownBlocks(markdown: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  for (const rawLine of withoutCode.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    if (heading) {
      const text = cleanMarkdownInline(heading[1]!);
      if (text) blocks.push({ type: 'heading', text });
      continue;
    }
    if (/^[-*>|]|^\d+\.|^!\[|^\[/.test(line)) continue; // skip lists, quotes, tables, images, links
    if (/^<|<[a-z][^>]*>|\w+=["']/i.test(line)) continue; // skip raw HTML embedded in the markdown
    const text = cleanMarkdownInline(line);
    if (text.length >= 20) blocks.push({ type: 'text', text });
  }
  return blocks;
}

function cleanMarkdownInline(input: string): string {
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Map extracted content onto a storyboard: an opening title card, then a
 * capped number of scenes chosen by simple heuristics (headings → title cards,
 * longer text → quote cards, a leading number → a stat reveal).
 */
export function buildStoryboardFromContent(
  content: ExtractedContent,
  opts: { maxScenes?: number | undefined } = {},
): HtmlVideoScene[] {
  const maxScenes = Math.max(1, Math.min(opts.maxScenes ?? 5, 10));
  const scenes: HtmlVideoScene[] = [
    {
      template: 'title-card',
      inputs: { title: truncate(content.title, 90), subtitle: content.subtitle },
    },
  ];

  const seen = new Set<string>();
  for (const block of content.blocks) {
    if (scenes.length >= maxScenes) break;
    const text = block.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);

    const leadingNumber = /^([€$]?\d[\d.,]*\s*[%+]?[^\s]{0,3})\b/.exec(text);
    if (block.type === 'heading' && leadingNumber && text.length <= 40) {
      scenes.push({
        template: 'stat-reveal',
        inputs: { value: leadingNumber[1]!.trim(), label: truncate(text, 60) },
      });
    } else if (block.type === 'heading') {
      scenes.push({ template: 'title-card', inputs: { title: truncate(text, 80) } });
    } else if (text.length >= 40) {
      scenes.push({ template: 'quote-card', inputs: { quote: truncate(text, 180), author: '' } });
    }
  }

  return scenes;
}
