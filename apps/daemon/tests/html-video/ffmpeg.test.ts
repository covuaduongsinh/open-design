import { describe, expect, it } from 'vitest';

import { buildConcatArgs, resolveFfmpeg } from '../../src/html-video/ffmpeg.js';

describe('html-video ffmpeg concat args', () => {
  it('builds a scale+pad+concat filter for every input', () => {
    const args = buildConcatArgs(['/a.mp4', '/b.mp4', '/c.mp4'], '/out.mp4', {
      width: 1920,
      height: 1080,
      fps: 30,
    });
    // one -i per input
    expect(args.filter((a) => a === '-i')).toHaveLength(3);
    const filterIdx = args.indexOf('-filter_complex');
    expect(filterIdx).toBeGreaterThan(-1);
    const filter = args[filterIdx + 1]!;
    // scales every input and concatenates exactly n=3 video streams
    expect(filter).toContain('[0:v]scale=1920:1080');
    expect(filter).toContain('[2:v]scale=1920:1080');
    expect(filter).toContain('concat=n=3:v=1:a=0[v]');
    expect(args).toContain('-map');
    expect(args[args.length - 1]).toBe('/out.mp4');
  });

  it('defaults fps to 30 when unset', () => {
    const args = buildConcatArgs(['/a.mp4'], '/out.mp4', { width: 1080, height: 1920 });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('fps=30');
    expect(args).toContain('-r');
  });

  it('honours OD_FFMPEG_PATH override', () => {
    const prev = process.env.OD_FFMPEG_PATH;
    try {
      process.env.OD_FFMPEG_PATH = '/opt/ffmpeg/bin/ffmpeg';
      expect(resolveFfmpeg()).toBe('/opt/ffmpeg/bin/ffmpeg');
      delete process.env.OD_FFMPEG_PATH;
      expect(resolveFfmpeg()).toBe('ffmpeg');
    } finally {
      if (prev == null) delete process.env.OD_FFMPEG_PATH;
      else process.env.OD_FFMPEG_PATH = prev;
    }
  });
});
