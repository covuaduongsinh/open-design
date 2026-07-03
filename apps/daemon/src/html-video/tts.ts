// Text-to-speech narration for the html-video capability.
//
// Two providers:
//   - vbee    — Vbee AI Voice (Vietnamese-first). Async: submit → poll →
//               download. Auth is an app_id + Bearer access token.
//   - minimax — MiniMax T2A v2. Synchronous; returns hex-encoded audio. Auth
//               is an API key + GroupId.
//
// The request builders are pure (no network) so they can be unit-tested; the
// synthesize* functions perform the fetch/poll. Network calls are not
// exercised in CI (no keys), so keep the builders authoritative.

export type TtsProvider = 'vbee' | 'minimax';

export interface TtsCredentials {
  apiKey?: string | undefined;
  /** Vbee app id (OD_VBEE_APP_ID). */
  appId?: string | undefined;
  /** MiniMax group id (OD_MINIMAX_GROUP_ID). */
  groupId?: string | undefined;
  baseUrl?: string | undefined;
}

export interface SynthesizeSpeechArgs {
  provider: TtsProvider;
  text: string;
  voice?: string | undefined;
  credentials: TtsCredentials;
  onProgress?: ((line: string) => void) | undefined;
}

const DEFAULT_VBEE_BASE = 'https://vbee.vn';
const DEFAULT_MINIMAX_BASE = 'https://api.minimaxi.chat';
const DEFAULT_VBEE_VOICE = 'hn_female_ngochuyen_full_48k-fhg';
const DEFAULT_MINIMAX_VOICE = 'male-qn-qingse';

export interface HttpRequestSpec {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Build the Vbee TTS submit request (pure). */
export function buildVbeeSubmit(args: {
  text: string;
  voice?: string | undefined;
  credentials: TtsCredentials;
}): HttpRequestSpec {
  const base = (args.credentials.baseUrl || DEFAULT_VBEE_BASE).replace(/\/$/, '');
  return {
    url: `${base}/api/v1/tts`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.credentials.apiKey ?? ''}`,
    },
    body: JSON.stringify({
      app_id: args.credentials.appId ?? '',
      input_text: args.text,
      voice_code: args.voice || DEFAULT_VBEE_VOICE,
      audio_type: 'mp3',
      bitrate: 128,
      speed_rate: '1.0',
    }),
  };
}

/** Build the MiniMax T2A v2 request (pure). */
export function buildMinimaxT2A(args: {
  text: string;
  voice?: string | undefined;
  credentials: TtsCredentials;
}): HttpRequestSpec {
  const base = (args.credentials.baseUrl || DEFAULT_MINIMAX_BASE).replace(/\/$/, '');
  const groupId = encodeURIComponent(args.credentials.groupId ?? '');
  return {
    url: `${base}/v1/t2a_v2?GroupId=${groupId}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.credentials.apiKey ?? ''}`,
    },
    body: JSON.stringify({
      model: 'speech-01-turbo',
      text: args.text,
      stream: false,
      voice_setting: { voice_id: args.voice || DEFAULT_MINIMAX_VOICE, speed: 1.0, vol: 1.0 },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000 },
    }),
  };
}

function assertText(text: string): void {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('narration text is required');
  }
}

/** Synthesize narration audio, returning MP3 bytes. */
export async function synthesizeSpeech(
  args: SynthesizeSpeechArgs,
): Promise<{ bytes: Buffer; ext: string }> {
  assertText(args.text);
  if (args.provider === 'vbee') return synthesizeVbee(args);
  if (args.provider === 'minimax') return synthesizeMinimax(args);
  throw new Error(`unknown tts provider: ${args.provider}`);
}

async function synthesizeVbee(
  args: SynthesizeSpeechArgs,
): Promise<{ bytes: Buffer; ext: string }> {
  if (!args.credentials.apiKey) {
    throw new Error('Vbee requires an access token — set OD_VBEE_TOKEN.');
  }
  if (!args.credentials.appId) {
    throw new Error('Vbee requires an app id — set OD_VBEE_APP_ID.');
  }
  const submit = buildVbeeSubmit({
    text: args.text,
    voice: args.voice,
    credentials: args.credentials,
  });
  args.onProgress?.('vbee: submitting narration');
  const submitResp = await fetch(submit.url, {
    method: submit.method,
    headers: submit.headers,
    body: submit.body,
  });
  if (!submitResp.ok) {
    throw new Error(`vbee submit failed: ${submitResp.status} ${await safeText(submitResp)}`);
  }
  const submitJson: any = await submitResp.json();
  const requestId = submitJson?.result?.request_id ?? submitJson?.result?.requestId;
  if (!requestId) {
    throw new Error('vbee submit returned no request_id');
  }

  const base = (args.credentials.baseUrl || DEFAULT_VBEE_BASE).replace(/\/$/, '');
  // Poll for completion (Vbee synthesizes asynchronously).
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(1500);
    const statusResp = await fetch(`${base}/api/v1/tts/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${args.credentials.apiKey}` },
    });
    if (!statusResp.ok) continue;
    const statusJson: any = await statusResp.json();
    const status = statusJson?.result?.status;
    const audioLink = statusJson?.result?.audio_link ?? statusJson?.result?.audioLink;
    if (status === 'SUCCESS' && audioLink) {
      args.onProgress?.('vbee: downloading narration');
      const audioResp = await fetch(audioLink);
      if (!audioResp.ok) throw new Error(`vbee audio download failed: ${audioResp.status}`);
      return { bytes: Buffer.from(await audioResp.arrayBuffer()), ext: '.mp3' };
    }
    if (status === 'FAILURE' || status === 'FAILED') {
      throw new Error('vbee synthesis failed');
    }
    args.onProgress?.(`vbee: ${status ?? 'processing'} (${attempt + 1})`);
  }
  throw new Error('vbee synthesis timed out');
}

async function synthesizeMinimax(
  args: SynthesizeSpeechArgs,
): Promise<{ bytes: Buffer; ext: string }> {
  if (!args.credentials.apiKey) {
    throw new Error('MiniMax requires an API key — set OD_MINIMAX_API_KEY.');
  }
  if (!args.credentials.groupId) {
    throw new Error('MiniMax TTS requires a group id — set OD_MINIMAX_GROUP_ID.');
  }
  const req = buildMinimaxT2A({
    text: args.text,
    voice: args.voice,
    credentials: args.credentials,
  });
  args.onProgress?.('minimax: synthesizing narration');
  const resp = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  if (!resp.ok) {
    throw new Error(`minimax t2a failed: ${resp.status} ${await safeText(resp)}`);
  }
  const json: any = await resp.json();
  const hex = json?.data?.audio;
  if (typeof hex !== 'string' || !hex) {
    const msg = json?.base_resp?.status_msg || 'no audio in response';
    throw new Error(`minimax t2a returned no audio: ${msg}`);
  }
  return { bytes: Buffer.from(hex, 'hex'), ext: '.mp3' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 240);
  } catch {
    return '';
  }
}
