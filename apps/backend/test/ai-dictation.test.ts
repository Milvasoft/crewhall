import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiRuns } from '@crewhall/db';
import { AI_LIMITS, AI_RAW_PATHS, ApiErrorBody, AiTranscription } from '@crewhall/shared';
import { FakeProvider } from './ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Sesle yazma through the org's speech server (browsers without speech recognition). */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;

const URL_ = `http://localhost:3000${AI_RAW_PATHS.transcribe}`;
const audio = Buffer.from('OggS fake opus frames '.repeat(40));

async function post(who: Client, body: Uint8Array, type = 'audio/webm;codecs=opus') {
  const res = await who.fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
  });
  const json: unknown = await res.json();
  return { status: res.status, json };
}

const codeOf = (json: unknown) => ApiErrorBody.parse(json).code;

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member')).person;
  await owner.api.call('updateAiSettings', {
    body: { enabled: true, provider: 'openai_compatible', baseUrl: `${fake.url}/v1`, model: 'llm' },
  });
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

describe('dictation', () => {
  it('needs the speech server, and says so in the status', async () => {
    expect((await elif.api.call('getAiStatus')).dictation).toBe(false);
    const out = await post(elif, audio);
    expect(out.status).toBe(409);
    expect(codeOf(out.json)).toBe('ai_transcription_not_configured');
  });

  it('turns a recording into text and records a dictate run', async () => {
    await owner.api.call('updateAiSettings', {
      body: { transcriptionUrl: `${fake.url}/v1`, transcriptionModel: 'whisper-small' },
    });
    expect((await elif.api.call('getAiStatus')).dictation).toBe(true);
    fake.transcript = 'Yarın toplantım var mı';
    const out = await post(elif, audio);
    expect(out.status).toBe(200);
    expect(AiTranscription.parse(out.json)).toEqual({
      text: 'Yarın toplantım var mı',
      language: 'tr',
    });
    expect(fake.transcriptions).toHaveLength(1);
    expect(fake.transcriptions[0]!.model).toBe('whisper-small');

    const runs = await app.deps.db.select().from(aiRuns).where(eq(aiRuns.action, 'dictate'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', inputTokens: 0, model: 'whisper-small' });
    expect(runs[0]!.outputTokens).toBeGreaterThan(0);
  });

  it('accepts audio only, of a bounded size', async () => {
    const wrong = await post(elif, audio, 'application/json');
    expect(wrong.status).toBe(422);
    const big = await post(elif, new Uint8Array(AI_LIMITS.dictationBytes + 1));
    expect(big.status).toBe(413);
    expect(codeOf(big.json)).toBe('file_too_large');
    expect(fake.transcriptions).toHaveLength(0);
  });

  it('maps a refused key of the speech server and still counts the call', async () => {
    fake.mode = 'unauthorized';
    const out = await post(elif, audio);
    expect(codeOf(out.json)).toBe('ai_not_configured');
    const failed = await app.deps.db.select().from(aiRuns).where(eq(aiRuns.status, 'error'));
    expect(failed.some((r) => r.action === 'dictate')).toBe(true);
  });

  it('stops when AI is off or the monthly quota is used up', async () => {
    fake.mode = 'ok';
    await owner.api.call('updateAiSettings', { body: { userMonthlyTokens: 1 } });
    const quota = await post(elif, audio);
    expect(quota.status).toBe(429);
    expect(codeOf(quota.json)).toBe('ai_quota_exceeded');
    await owner.api.call('updateAiSettings', { body: { enabled: false, userMonthlyTokens: null } });
    expect(codeOf((await post(elif, audio)).json)).toBe('ai_disabled');
    expect(fake.transcriptions).toHaveLength(0);
  });
});
