import { describe, expect, it } from 'vitest';

import { buildMinimaxT2A, buildVbeeSubmit } from '../../src/html-video/tts.js';
import { buildMixArgs } from '../../src/html-video/ffmpeg.js';

describe('html-video TTS request builders', () => {
  it('builds a Vbee submit request with app id + bearer token', () => {
    const req = buildVbeeSubmit({
      text: 'Xin chào',
      voice: 'hn_female_test',
      credentials: { apiKey: 'tok', appId: 'app123' },
    });
    expect(req.url).toBe('https://vbee.vn/api/v1/tts');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(req.body);
    expect(body.app_id).toBe('app123');
    expect(body.input_text).toBe('Xin chào');
    expect(body.voice_code).toBe('hn_female_test');
    expect(body.audio_type).toBe('mp3');
  });

  it('honours a custom Vbee base url', () => {
    const req = buildVbeeSubmit({
      text: 'hi',
      credentials: { apiKey: 't', appId: 'a', baseUrl: 'https://proxy.example/' },
    });
    expect(req.url).toBe('https://proxy.example/api/v1/tts');
  });

  it('builds a MiniMax T2A request with GroupId in the query', () => {
    const req = buildMinimaxT2A({
      text: 'hello',
      credentials: { apiKey: 'k', groupId: 'g42' },
    });
    expect(req.url).toContain('/v1/t2a_v2?GroupId=g42');
    expect(req.headers.authorization).toBe('Bearer k');
    const body = JSON.parse(req.body);
    expect(body.text).toBe('hello');
    expect(body.audio_setting.format).toBe('mp3');
  });
});

describe('html-video soundtrack mix args', () => {
  it('narration only maps the video plus a padded narration track', () => {
    const args = buildMixArgs('/v.mp4', '/o.mp4', { narrationPath: '/n.mp3' });
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('[1:a]apad[a]');
    expect(args).toContain('-shortest');
    expect(args).toContain('copy'); // video stream copied, not re-encoded
  });

  it('music-only ducks the music by the given volume', () => {
    const args = buildMixArgs('/v.mp4', '/o.mp4', { musicPath: '/m.mp3', musicVolume: 0.1 });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('volume=0.1');
  });

  it('narration + music mixes both, music ducked, default volume', () => {
    const args = buildMixArgs('/v.mp4', '/o.mp4', {
      narrationPath: '/n.mp3',
      musicPath: '/m.mp3',
    });
    expect(args.filter((a) => a === '-i')).toHaveLength(3);
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    expect(filter).toContain('amix=inputs=2');
    expect(filter).toContain('volume=0.22');
  });

  it('throws when no audio track is supplied', () => {
    expect(() => buildMixArgs('/v.mp4', '/o.mp4', {})).toThrow(/requires a narration or music/);
  });
});
