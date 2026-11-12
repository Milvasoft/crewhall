import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, meetings, newId, pages, recordings } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { DEFAULT_MEETING_SETTINGS } from '@crewhall/shared';
import { notesMarkdown, parseSummary, runMeetingNotes } from '../src/services/ai/meeting';
import { FakeProvider } from './ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/** Toplantı asistanı (yol haritası #12): transcript, summary, notes page, board cards. */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;
let can: Client;
let ownerId: string;
let orgId: string;
let spaceId: string;
let meetingId: string;
let recordingId: string;
let boardId: string;

const SUMMARY = JSON.stringify({
  summary: '- Sürüm cuma çıkıyor.',
  decisions: ['Sürüm cuma 17:00de çıkacak'],
  action_items: [
    { title: 'Test raporunu hazırla', owner: 'Elif', due: '2026-10-29' },
    { title: 'Sürüm notlarını yaz', owner: null, due: null },
  ],
});

async function expectCode(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  expect((err as ApiError).code).toBe(code);
}

/** A finished recording in Drive, as `recording.ingest` leaves it. */
async function makeRecording(title: string) {
  const id = newId();
  await app.deps.db.insert(meetings).values({
    id,
    orgId,
    kind: 'room',
    title,
    spaceId,
    roomName: `room-${id}`,
    joinSlug: `slug-${id.slice(-12)}`,
    hostUserId: ownerId,
    settings: DEFAULT_MEETING_SETTINGS,
  });
  const up = await uploadFile(owner, {
    spaceId,
    name: `${title}.m4a`,
    content: Buffer.from('fake audio bytes'),
    mime: 'audio/mp4',
  });
  const [blob] = await app.deps.db
    .execute<{ storage_key: string }>(
      // The upload's blob is the recording's storage key.
      (await import('drizzle-orm')).sql`select b.storage_key from node_versions v
      join blobs b on b.id = v.blob_id where v.node_id = ${up.node.id}`,
    )
    .then((r) => r.rows);
  const rid = newId();
  await app.deps.db.insert(recordings).values({
    id: rid,
    orgId,
    meetingId: id,
    status: 'ready',
    audioOnly: true,
    storageKey: blob!.storage_key,
    spaceId,
    nodeId: up.node.id,
    startedBy: ownerId,
    startedAt: new Date('2026-10-22T09:00:00Z'),
    endedAt: new Date('2026-10-22T10:00:00Z'),
  });
  return { meetingId: id, recordingId: rid };
}

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  orgId = setup.orgId;
  ownerId = setup.ownerId;
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId])).person;
  can = (await join(app, owner, 'can@milvasoft.com', 'member')).person;
  const board = await owner.api.call('createBoard', {
    params: { spaceId },
    body: { name: 'Sürüm', template: 'sprint' },
  });
  boardId = board.id;
  ({ meetingId, recordingId } = await makeRecording('Haftalık sürüm toplantısı'));
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

describe('settings', () => {
  it('stays off until a speech server is set', async () => {
    await owner.api.call('updateAiSettings', {
      body: {
        enabled: true,
        provider: 'openai_compatible',
        baseUrl: `${fake.url}/v1`,
        model: 'llm',
      },
    });
    const state = await elif.api.call('getMeetingTranscript', { params: { recordingId } });
    expect(state).toEqual({ available: false, transcript: null });
    await expectCode(
      elif.api.call('startMeetingTranscript', { params: { recordingId }, body: {} }),
      409,
      'ai_transcription_not_configured',
    );
    const saved = await owner.api.call('updateAiSettings', {
      body: {
        transcriptionUrl: `${fake.url}/v1`,
        transcriptionModel: 'Systran/faster-whisper-small',
        apiKey: 'sk-local-0123456789abcd',
      },
    });
    expect(saved).toMatchObject({
      transcriptionUrl: `${fake.url}/v1`,
      transcriptionModel: 'Systran/faster-whisper-small',
      meetingNotes: false,
    });
  });
});

describe('transcript and notes', () => {
  it('is 404 for someone who cannot open the recording', async () => {
    await expectCode(
      can.api.call('getMeetingTranscript', { params: { recordingId } }),
      404,
      'not_found',
    );
    await expectCode(
      can.api.call('startMeetingTranscript', { params: { recordingId }, body: {} }),
      404,
      'not_found',
    );
  });

  it('transcribes, summarizes and writes the notes page', async () => {
    fake.reply = SUMMARY;
    const started = await elif.api.call('startMeetingTranscript', {
      params: { recordingId },
      body: {},
    });
    // Jobs run inline in tests: the whole pipeline is done.
    const t = started.transcript!;
    expect(t).toMatchObject({
      status: 'ready',
      language: 'tr',
      summary: '- Sürüm cuma çıkıyor.',
      decisions: ['Sürüm cuma 17:00de çıkacak'],
    });
    expect(t.text).toContain('Elif test raporunu');
    expect(t.actions[0]).toMatchObject({
      title: 'Test raporunu hazırla',
      owner: 'Elif',
      due: '2026-10-29',
    });

    // The speech server got the audio with the configured model and the org key (same server).
    expect(fake.transcriptions[0]).toMatchObject({
      model: 'Systran/faster-whisper-small',
      auth: 'Bearer sk-local-0123456789abcd',
    });
    expect(fake.allPromptText()).toContain('<transcript>');

    const [page] = await app.deps.db.select().from(pages).where(eq(pages.nodeId, t.pageNodeId!));
    expect(page!.markdown).toContain('Test raporunu hazırla');
    expect(page!.markdown).toContain('Sürüm cuma 17:00de çıkacak');
    const node = await elif.api.call('getNode', { params: { nodeId: t.pageNodeId! } });
    expect(node.name).toContain('Haftalık sürüm toplantısı');

    // The summary run counts for the person who recorded.
    const usage = await owner.api.call('getAiUsage', { query: {} });
    expect(usage.byAction.map((x) => x.action)).toContain('meeting_notes');
  });

  it('turns an action item into a board card with one click, once', async () => {
    const state = await elif.api.call('getMeetingTranscript', { params: { recordingId } });
    const t = state.transcript!;
    // Elif may read the notes but not edit the board: the board's own rules apply.
    await expectCode(
      elif.api.call('createMeetingActionCard', {
        params: { transcriptId: t.id, index: '0' },
        body: { boardId },
      }),
      403,
      'forbidden',
    );
    const after = await owner.api.call('createMeetingActionCard', {
      params: { transcriptId: t.id, index: '0' },
      body: { boardId },
    });
    expect(after.actions[0]).toMatchObject({ boardId, cardNumber: expect.any(Number) });
    const card = await owner.api.call('getBoardCard', {
      params: { cardId: after.actions[0]!.cardId! },
    });
    expect(card.title).toBe('Test raporunu hazırla');
    expect(card.dueAt).toBe('2026-10-29T09:00:00.000Z');
    const again = await owner.api.call('createMeetingActionCard', {
      params: { transcriptId: t.id, index: '0' },
      body: { boardId },
    });
    expect(again.actions[0]!.cardId).toBe(after.actions[0]!.cardId);
    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'ai.suggestion.accept'), eq(auditLogs.targetType, 'card')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.via).toMatchObject({ kind: 'ai' });
    await expectCode(
      owner.api.call('createMeetingActionCard', {
        params: { transcriptId: t.id, index: '9' },
        body: { boardId },
      }),
      404,
      'not_found',
    );
  });

  it('writes the notes page again when it was deleted', async () => {
    const t = (await owner.api.call('getMeetingTranscript', { params: { recordingId } }))
      .transcript!;
    await owner.api.call('trashNodes', { body: { nodeIds: [t.pageNodeId!] } });
    await expectCode(
      elif.api.call('createMeetingNotesPage', { params: { transcriptId: t.id }, body: {} }),
      403,
      'forbidden',
    );
    const again = await owner.api.call('createMeetingNotesPage', {
      params: { transcriptId: t.id },
      body: {},
    });
    expect(again.pageNodeId).toBeTruthy();
    expect(again.pageNodeId).not.toBe(t.pageNodeId);
  });

  it('records a failure from the speech server', async () => {
    const other = await makeRecording('Bozuk kayıt');
    fake.mode = 'unauthorized';
    const state = await elif.api.call('startMeetingTranscript', {
      params: { recordingId: other.recordingId },
      body: {},
    });
    // A key the speech server refuses: the settings need fixing (same as the chat providers).
    expect(state.transcript).toMatchObject({ status: 'failed', error: 'ai_not_configured' });
  });
});

describe('automatic meeting notes', () => {
  it('runs after a recording only when the org turned it on', async () => {
    const quiet = await makeRecording('Sessiz toplantı');
    await runMeetingNotes(app.deps, quiet.recordingId);
    expect(fake.transcriptions).toHaveLength(0);

    await owner.api.call('updateAiSettings', { body: { meetingNotes: true } });
    fake.reply = SUMMARY;
    const auto = await makeRecording('Otomatik notlu toplantı');
    await runMeetingNotes(app.deps, auto.recordingId);
    const state = await owner.api.call('getMeetingTranscript', {
      params: { recordingId: auto.recordingId },
    });
    expect(state.transcript).toMatchObject({ status: 'ready' });
    expect(state.transcript!.pageNodeId).toBeTruthy();
    // A second run (job retry) does not transcribe again.
    await runMeetingNotes(app.deps, auto.recordingId);
    expect(fake.transcriptions).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('parses the model JSON, also inside a code fence, else keeps the text', () => {
    expect(parseSummary('```json\n' + SUMMARY + '\n```').actions).toHaveLength(2);
    expect(parseSummary('Düz metin özet.')).toEqual({
      summary: 'Düz metin özet.',
      decisions: [],
      actions: [],
    });
    const bad = parseSummary(
      JSON.stringify({ summary: 's', action_items: [{ title: 'x', due: 'yarın' }] }),
    );
    expect(bad.actions[0]!.due).toBeNull();
  });

  it('builds the notes page in the org language and cuts long transcripts', () => {
    const row = {
      summary: 'Özet',
      decisions: ['Karar'],
      actions: [{ title: 'İş', owner: 'Can', due: null }],
      text: 'x'.repeat(5_000),
    } as unknown as Parameters<typeof notesMarkdown>[0];
    const md = notesMarkdown(row, { date: new Date('2026-10-22T09:00:00Z'), locale: 'en' }, 1_000);
    expect(md).toContain('## Decisions');
    expect(md).toContain('- [ ] İş — Can');
    expect(md).toContain('shortened');
    expect(md.length).toBeLessThan(1_200);
    expect(meetingId).toBeTruthy();
  });
});
