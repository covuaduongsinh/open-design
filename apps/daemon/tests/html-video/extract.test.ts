import { describe, expect, it } from 'vitest';

import {
  buildStoryboardFromContent,
  extractArticleFromHtml,
  extractMarkdownBlocks,
  parseRepoRef,
} from '../../src/html-video/extract.js';

describe('html-video article extraction', () => {
  const html = `
    <html><head><title>Fallback Title</title>
    <meta property="og:title" content="Q3 Results &amp; Outlook" />
    <style>.x{color:red}</style></head>
    <body>
      <nav><a>skip me</a></nav>
      <h1>Q3 Results &amp; Outlook</h1>
      <p>Revenue grew significantly across every region this quarter.</p>
      <script>console.log('drop me')</script>
      <h2>40% growth</h2>
      <p>Short</p>
      <footer>© 2026 drop me too</footer>
    </body></html>`;

  it('extracts title (prefers og:title), host, and content blocks', () => {
    const content = extractArticleFromHtml(html, 'https://example.com/q3');
    expect(content.title).toBe('Q3 Results & Outlook');
    expect(content.subtitle).toBe('example.com');
    // script/style/nav/footer text is dropped
    const joined = content.blocks.map((b) => b.text).join(' | ');
    expect(joined).not.toContain('drop me');
    expect(joined).not.toContain('skip me');
    expect(content.blocks.some((b) => b.type === 'heading' && b.text === '40% growth')).toBe(true);
    // too-short block ("Short") is filtered from text blocks by the storyboard step
    expect(content.blocks.some((b) => b.text.includes('Revenue grew'))).toBe(true);
  });

  it('builds a storyboard: title card first, capped scenes, stat heuristic', () => {
    const content = extractArticleFromHtml(html, 'https://example.com/q3');
    const scenes = buildStoryboardFromContent(content, { maxScenes: 4 });
    expect(scenes[0]?.template).toBe('title-card');
    expect(scenes.length).toBeLessThanOrEqual(4);
    // "40% growth" heading with a leading number → stat-reveal
    expect(scenes.some((s) => s.template === 'stat-reveal')).toBe(true);
    // long paragraph → quote-card
    expect(scenes.some((s) => s.template === 'quote-card')).toBe(true);
  });
});

describe('html-video repo ref + markdown extraction', () => {
  it('parses owner/repo from slug and url forms', () => {
    expect(parseRepoRef('nexu-io/open-design')).toEqual({ owner: 'nexu-io', repo: 'open-design' });
    expect(parseRepoRef('https://github.com/heygen-com/hyperframes.git')).toEqual({
      owner: 'heygen-com',
      repo: 'hyperframes',
    });
    expect(parseRepoRef('not a repo')).toBeNull();
  });

  it('extracts headings and paragraphs from markdown, skipping code/lists', () => {
    const md = [
      '# Project Title',
      '',
      'A concise sentence describing what the project actually does for you.',
      '',
      '```js',
      'const x = 1; // should be dropped',
      '```',
      '- a list item that should be skipped',
      '## Features',
    ].join('\n');
    const blocks = extractMarkdownBlocks(md);
    expect(blocks.some((b) => b.type === 'heading' && b.text === 'Project Title')).toBe(true);
    expect(blocks.some((b) => b.type === 'heading' && b.text === 'Features')).toBe(true);
    expect(blocks.some((b) => b.text.includes('concise sentence'))).toBe(true);
    expect(blocks.every((b) => !b.text.includes('const x'))).toBe(true);
    expect(blocks.every((b) => !b.text.includes('list item'))).toBe(true);
  });
});
