import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateHtmlVideo } from '../../src/html-video/index.js';

describe('html-video generator preflight', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-html-video-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(path.join(projectsRoot, 'project-1'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('requires a composition dir', async () => {
    await expect(
      generateHtmlVideo({
        projectRoot,
        projectsRoot,
        projectId: 'project-1',
      }),
    ).rejects.toThrow(/requires --composition-dir/);
  });

  it('rejects a template-only request until the library ships', async () => {
    await expect(
      generateHtmlVideo({
        projectRoot,
        projectsRoot,
        projectId: 'project-1',
        template: 'stars-race',
      }),
    ).rejects.toThrow(/template rendering is not available yet/);
  });

  it('refuses a composition dir that escapes the project', async () => {
    await expect(
      generateHtmlVideo({
        projectRoot,
        projectsRoot,
        projectId: 'project-1',
        compositionDir: '../../../etc',
      }),
    ).rejects.toThrow(/resolves outside the project directory/);
  });

  it('rejects an incomplete composition instead of rendering', async () => {
    const compRel = '.hyperframes-cache/incomplete';
    const compDir = path.join(projectsRoot, 'project-1', compRel);
    await mkdir(compDir, { recursive: true });
    await writeFile(
      path.join(compDir, 'index.html'),
      '<!doctype html><div id="root"></div>',
      'utf8',
    );

    await expect(
      generateHtmlVideo({
        projectRoot,
        projectsRoot,
        projectId: 'project-1',
        compositionDir: compRel,
      }),
    ).rejects.toThrow(/compositionDir is missing hyperframes\.json/);
  });
});
