import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCompositionFromTemplate,
  findHtmlVideoTemplate,
  listHtmlVideoTemplates,
  loadHtmlVideoTemplates,
  renderTemplateHtml,
} from '../../src/html-video/templates.js';

// Point at the real vendored templates under design-templates/html-video/.
const repoDesignTemplates = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../design-templates',
);
const roots = [repoDesignTemplates];

describe('html-video template loader', () => {
  it('loads the vendored templates', () => {
    const ids = loadHtmlVideoTemplates(roots).map((t) => t.id);
    expect(ids).toContain('title-card');
    expect(ids).toContain('stat-reveal');
    expect(ids).toContain('quote-card');
  });

  it('ranks templates by search intent', () => {
    const results = listHtmlVideoTemplates(roots, 'metric number stat');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe('stat-reveal');
  });

  it('returns all templates when search is empty', () => {
    expect(listHtmlVideoTemplates(roots).length).toBeGreaterThanOrEqual(3);
  });

  it('finds a template with its input slots', () => {
    const t = findHtmlVideoTemplate(roots, 'title-card');
    expect(t).not.toBeNull();
    expect(t?.inputs.title).toBeTruthy();
    expect(t?.durationSec).toBeGreaterThan(0);
  });
});

describe('html-video template rendering', () => {
  it('substitutes slots, escapes text, and resolves duration', () => {
    const t = findHtmlVideoTemplate(roots, 'title-card')!;
    const html = renderTemplateHtml(t, {
      title: 'Hello <script>alert(1)</script>',
      subtitle: 'Q3 & beyond',
    });
    expect(html).not.toContain('{{');
    // Text slot is HTML-escaped — no live script tag, ampersand encoded.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Q3 &amp; beyond');
    // duration slot resolves to a number.
    expect(html).toContain(`data-duration="${t.durationSec}"`);
  });

  it('rejects unsafe color slot values, falling back to the default', () => {
    const t = findHtmlVideoTemplate(roots, 'title-card')!;
    const html = renderTemplateHtml(t, { accent: 'red; background: url(evil)' });
    expect(html).not.toContain('url(evil)');
    expect(html).toContain(t.inputs.accent!.default);
  });

  it('builds a three-file HyperFrames composition', () => {
    const t = findHtmlVideoTemplate(roots, 'quote-card')!;
    const files = buildCompositionFromTemplate(t, { quote: 'Ship it.' });
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['hyperframes.json', 'index.html', 'meta.json']);
    const index = files.find((f) => f.name === 'index.html')!;
    expect(index.content).toContain('Ship it.');
    expect(index.content).not.toContain('{{');
  });
});
