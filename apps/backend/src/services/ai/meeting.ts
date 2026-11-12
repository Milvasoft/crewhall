import { and, asc, eq } from 'drizzle-orm';
import {
  boardColumns,
  meetingTranscripts,
  meetings,
  nodes,
  recordings,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import {
  AI_PROVIDER_INFO,
  BOARD_LIMITS,
  CreateBoardCard,
  type Locale,
  type MeetingAction,
  type MeetingTranscript,
  type MeetingTranscriptState,
  type OrgSettings,
} from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { createCard } from '../boards/cards';
import { inBoardsTx } from '../boards/integrations';
import { loadNode, type DriveActor } from '../drive/access';
import { isModuleEnabled } from '../identity/modules';
import { actorFor } from '../wiki/access';
import { createPage } from '../wiki/pages';
import { aiAudit } from './audit';
import { meetingPrompt } from './prompts';
import { ProviderError } from './providers';
import { providerErrorFrom } from './providers/http';
import { executeRun, providerAppError, usableSettings, type AiCaller } from './run';
import { loadSettings, modelConfigOf, type SettingsRow } from './settings';

/**
 * Toplantı asistanı (yol haritası #12): a ready recording is transcribed by the org's
 * OpenAI-compatible speech server (`/audio/transcriptions`: faster-whisper behind speaches,
 * vLLM, LocalAI …), summarized by the org model into a summary, decisions and action items,
 * and written to a meeting-notes page next to the recording. Action items become board cards
 * with one click. Whoever can open the recording file can see its transcript.
 */

type TranscriptRow = typeof meetingTranscripts.$inferSelect;

/** Largest recording sent to the speech server. */
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
/** Transcript characters given to the model for the summary. */
const MAX_TRANSCRIPT_CHARS = 120_000;
const TIMEOUT_MS = 30 * 60_000;

// ---------------------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------------------

const Transcription = z.object({
  text: z.string(),
  language: z.string().nullish(),
  duration: z.number().nullish(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).nullish(),
});

export interface TranscriptionConfig {
  url: string;
  model: string;
  apiKey: string | null;
}

export function transcriptionConfigOf(
  deps: Pick<Deps, 'env'>,
  settings: SettingsRow | null,
): TranscriptionConfig | null {
  if (!settings?.transcriptionUrl || !settings.transcriptionModel) return null;
  // The org key goes only to the server it was entered for (kararlar.md).
  const sameServer =
    (settings.provider === 'openai_compatible' || settings.provider === 'openai') &&
    (settings.baseUrl ?? AI_PROVIDER_INFO[settings.provider].defaultBaseUrl) ===
      settings.transcriptionUrl;
  let apiKey: string | null = null;
  if (sameServer) {
    try {
      apiKey = modelConfigOf(deps, settings).apiKey;
    } catch {
      apiKey = null;
    }
  }
  return { url: settings.transcriptionUrl, model: settings.transcriptionModel, apiKey };
}

export async function transcribe(
  cfg: TranscriptionConfig,
  audio: Buffer,
  fileName: string,
  mime: string,
) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(audio)], { type: mime }), fileName);
  form.set('model', cfg.model);
  form.set('response_format', 'verbose_json');
  let res: Response;
  try {
    res = await fetch(`${cfg.url.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    });
  } catch {
    throw new ProviderError('connection failed', null, 'network');
  }
  // A refused key, a rate limit or an exhausted account map like the chat providers' errors.
  if (!res.ok) throw await providerErrorFrom(res);
  const parsed = Transcription.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ProviderError('invalid transcription response');
  return parsed.data;
}

// ---------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------

const SummaryJson = z.object({
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  action_items: z
    .array(
      z.object({
        title: z.string(),
        owner: z.string().nullish(),
        due: z.string().nullish(),
      }),
    )
    .default([]),
});

/** The model's JSON (tolerating a code fence or text around it); plain text as the summary. */
export function parseSummary(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = SummaryJson.safeParse(JSON.parse(text.slice(start, end + 1)));
      if (parsed.success) {
        return {
          summary: parsed.data.summary.trim(),
          decisions: parsed.data.decisions.map((d) => d.trim()).filter(Boolean),
          actions: parsed.data.action_items
            .filter((a) => a.title.trim())
            .map((a) => ({
              title: a.title.trim().slice(0, BOARD_LIMITS.titleLength),
              owner: a.owner?.trim() || null,
              due: a.due && /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? a.due : null,
            })),
        };
      }
    } catch {
      // Fall through to plain text.
    }
  }
  return { summary: text.trim(), decisions: [], actions: [] };
}

// ---------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------

const ActionsData = z.array(
  z.object({
    title: z.string(),
    owner: z.string().nullable(),
    due: z.string().nullable(),
    cardId: z.string().nullable().default(null),
    boardId: z.string().nullable().default(null),
    cardNumber: z.number().int().nullable().default(null),
  }),
);

const actionsOf = (row: TranscriptRow): MeetingAction[] => {
  const parsed = ActionsData.safeParse(row.actions);
  return parsed.success ? parsed.data : [];
};

const decisionsOf = (row: TranscriptRow): string[] => {
  const parsed = z.array(z.string()).safeParse(row.decisions);
  return parsed.success ? parsed.data : [];
};

export function toTranscriptView(row: TranscriptRow): MeetingTranscript {
  return {
    id: row.id,
    recordingId: row.recordingId,
    meetingId: row.meetingId,
    status: row.status,
    error: row.error,
    language: row.language,
    text: row.text,
    summary: row.summary,
    decisions: decisionsOf(row),
    actions: actionsOf(row),
    pageNodeId: row.pageNodeId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------

/** The recording if the caller can open its Drive file (404 otherwise, existence not revealed). */
async function recordingFor(db: DbOrTx, a: DriveActor, recordingId: string) {
  const [r] = await db
    .select()
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.orgId, a.org.id)));
  if (!r?.nodeId) throw new AppError('not_found');
  await loadNode(db, a, r.nodeId);
  return r;
}

async function transcriptOf(db: DbOrTx, recordingId: string) {
  const [row] = await db
    .select()
    .from(meetingTranscripts)
    .where(eq(meetingTranscripts.recordingId, recordingId));
  return row ?? null;
}

async function rowFor(db: DbOrTx, a: DriveActor, transcriptId: string) {
  const [row] = await db
    .select()
    .from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.id, transcriptId), eq(meetingTranscripts.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  await recordingFor(db, a, row.recordingId);
  return row;
}

const actorOf = (caller: AiCaller): DriveActor => ({
  org: caller.org,
  actor: caller.actor,
  userId: caller.userId,
});

export async function transcriptState(
  deps: Pick<Deps, 'db' | 'env'>,
  caller: AiCaller,
  recordingId: string,
): Promise<MeetingTranscriptState> {
  await recordingFor(deps.db, actorOf(caller), recordingId);
  const settings = await loadSettings(deps.db, caller.org.id);
  const row = await transcriptOf(deps.db, recordingId);
  return {
    available: !!settings?.enabled && transcriptionConfigOf(deps, settings) !== null,
    transcript: row ? toTranscriptView(row) : null,
  };
}

/** "Dökümü çıkar": queues the job for a ready recording the caller can open. */
export async function startTranscript(deps: Deps, caller: AiCaller, recordingId: string) {
  const r = await recordingFor(deps.db, actorOf(caller), recordingId);
  const settings = await usableSettings(deps, caller);
  if (!transcriptionConfigOf(deps, settings)) {
    throw new AppError('ai_transcription_not_configured');
  }
  if (r.status !== 'ready') throw new AppError('ai_recording_not_ready');
  const existing = await transcriptOf(deps.db, recordingId);
  if (!existing || !RUNNING.has(existing.status)) {
    await deps.db
      .insert(meetingTranscripts)
      .values({
        orgId: r.orgId,
        recordingId: r.id,
        meetingId: r.meetingId,
        requestedBy: caller.userId,
        status: 'queued',
      })
      .onConflictDoUpdate({
        target: meetingTranscripts.recordingId,
        set: { status: 'queued', error: null, requestedBy: caller.userId, updatedAt: new Date() },
      });
    await deps.jobs.send('ai.meeting_notes', { recordingId: r.id, manual: true });
  }
  return transcriptState(deps, caller, recordingId);
}

const RUNNING = new Set(['transcribing', 'summarizing']);

// ---------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------

export type MeetingNotesDeps = Pick<Deps, 'db' | 'env' | 'logger' | 'jobs' | 'storage' | 'bus'>;

async function setStatus(
  db: DbOrTx,
  id: string,
  patch: Partial<typeof meetingTranscripts.$inferInsert>,
) {
  await db
    .update(meetingTranscripts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(meetingTranscripts.id, id));
}

async function readAll(stream: AsyncIterable<unknown>, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    size += b.length;
    if (size > limit) throw new AppError('file_too_large');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

const localeOf = (org: { settings: unknown }): Locale =>
  (org.settings as Partial<OrgSettings>).defaultLocale === 'en' ? 'en' : 'tr';

/**
 * ai.meeting_notes: transcribe, summarize, write the notes page. After every recording
 * (`recording.ingest`) it runs only when the org turned meeting notes on; `manual` is the
 * "Dökümü çıkar" button. The person who started the recording is the author of the summary
 * run (their quota) and of the page.
 */
export async function runMeetingNotes(
  deps: MeetingNotesDeps,
  recordingId: string,
  opts: { manual?: boolean } = {},
) {
  const { db, logger } = deps;
  const [r] = await db.select().from(recordings).where(eq(recordings.id, recordingId));
  if (!r || r.status !== 'ready' || !r.nodeId || !r.startedBy) return;
  if (!(await isModuleEnabled(db, r.orgId, 'ai', { fresh: true }))) return;
  const settings = await loadSettings(db, r.orgId);
  if (!settings?.enabled) return;
  if (!opts.manual && !settings.meetingNotes) return;

  let row: TranscriptRow | null | undefined = await transcriptOf(db, r.id);
  if (row && (RUNNING.has(row.status) || (!opts.manual && row.status !== 'queued'))) return;
  if (!row) {
    [row] = await db
      .insert(meetingTranscripts)
      .values({ orgId: r.orgId, recordingId: r.id, meetingId: r.meetingId, status: 'queued' })
      .onConflictDoNothing()
      .returning();
    if (!row) return;
  }
  const id = row.id;
  const fail = (error: string) => setStatus(db, id, { status: 'failed', error });
  const tcfg = transcriptionConfigOf(deps, settings);
  if (!tcfg) return fail('ai_transcription_not_configured');
  if (!deps.storage) return fail('internal');

  const a = await actorFor(db, r.orgId, r.startedBy);
  const [person] = await db.select().from(users).where(eq(users.id, r.startedBy));
  const [m] = await db.select().from(meetings).where(eq(meetings.id, r.meetingId));
  if (!a || !person || !m) return fail('not_found');
  const caller: AiCaller = { ...a, userName: person.name };
  const locale = localeOf(a.org);

  try {
    await usableSettings(deps, caller);
    await setStatus(db, id, { status: 'transcribing', error: null });
    const head = await deps.storage.head(r.storageKey);
    if (!head || head.size > MAX_AUDIO_BYTES) return fail('file_too_large');
    const audio = await readAll(await deps.storage.getStream(r.storageKey), MAX_AUDIO_BYTES);
    const tr = await transcribe(
      tcfg,
      audio,
      r.audioOnly ? 'recording.m4a' : 'recording.mp4',
      r.audioOnly ? 'audio/mp4' : 'video/mp4',
    );
    await setStatus(db, id, {
      status: 'summarizing',
      text: tr.text,
      language: tr.language ?? null,
      segments: (tr.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
    });

    const out = await executeRun(
      deps,
      caller,
      {
        kind: 'model',
        action: 'meeting_notes',
        config: modelConfigOf(deps, settings),
        prompt: meetingPrompt(tr.text.slice(0, MAX_TRANSCRIPT_CHARS), {
          title: m.title,
          date: r.startedAt,
          locale,
        }),
        target: { type: 'recording', id: r.id },
      },
      { ip: null, userAgent: null, locale },
      {},
    );
    const parsed = parseSummary(out.text);
    await setStatus(db, id, {
      status: 'ready',
      summary: parsed.summary,
      decisions: parsed.decisions,
      actions: parsed.actions.map((x) => ({ ...x, cardId: null, boardId: null, cardNumber: null })),
      runId: out.runId,
    });
    const [ready] = await db.select().from(meetingTranscripts).where(eq(meetingTranscripts.id, id));
    await writeNotesPage(deps, a, ready!, {
      title: m.title,
      date: r.startedAt,
      nodeId: r.nodeId,
      locale,
    }).catch((err: unknown) => logger.warn({ err, recordingId }, 'meeting notes page not created'));
  } catch (err) {
    const code =
      err instanceof AppError
        ? err.code
        : err instanceof ProviderError
          ? providerAppError(err).code
          : 'internal';
    if (code === 'internal') logger.error({ err, recordingId }, 'meeting notes failed');
    await fail(code);
  }
}

// ---------------------------------------------------------------------------------------
// The notes page and board cards
// ---------------------------------------------------------------------------------------

/** Markdown of the notes page, in the org's language. */
export function notesMarkdown(
  t: TranscriptRow,
  meta: { date: Date; locale: Locale },
  maxChars = 400_000,
) {
  const tx = resources[meta.locale].email.ai.meetingNotes;
  const date = meta.date.toLocaleString(meta.locale === 'tr' ? 'tr-TR' : 'en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const decisions = decisionsOf(t);
  const actions = actionsOf(t);
  const parts = [
    `> ${tx.intro}`,
    `**${tx.date}:** ${date} (UTC)`,
    `## ${tx.summary}`,
    t.summary ?? '',
    `## ${tx.decisions}`,
    decisions.length ? decisions.map((d) => `- ${d}`).join('\n') : `_${tx.none}_`,
    `## ${tx.actions}`,
    actions.length
      ? actions
          .map(
            (x) => `- [ ] ${x.title}${x.owner ? ` — ${x.owner}` : ''}${x.due ? ` (${x.due})` : ''}`,
          )
          .join('\n')
      : `_${tx.none}_`,
    `## ${tx.transcript}`,
  ];
  const head = parts.join('\n\n');
  const text = t.text ?? '';
  const room = Math.max(0, maxChars - head.length - 200);
  const body = text.length > room ? `${text.slice(0, room)}\n\n_${tx.cut}_` : text;
  return `${head}\n\n${body}`;
}

async function writeNotesPage(
  deps: MeetingNotesDeps,
  a: DriveActor,
  t: TranscriptRow,
  meta: { title: string; date: Date; nodeId: string; locale: Locale },
) {
  if (!(await isModuleEnabled(deps.db, a.org.id, 'wiki'))) return null;
  const [file] = await deps.db.select().from(nodes).where(eq(nodes.id, meta.nodeId));
  if (!file) return null;
  const tx = resources[meta.locale].email.ai.meetingNotes;
  const day = meta.date.toISOString().slice(0, 10);
  const page = await createPage(
    deps,
    a,
    file.spaceId,
    {
      parentId: file.parentId,
      name: `${meta.title} · ${day} · ${tx.pageSuffix}`.slice(0, 200),
      markdown: notesMarkdown(t, meta),
    },
    { source: 'api', locale: meta.locale },
  );
  await setStatus(deps.db, t.id, { pageNodeId: page.id });
  return page.id;
}

/** "Not sayfası": (re)creates the notes page when it is missing or out of reach. */
export async function createNotesPage(deps: Deps, caller: AiCaller, transcriptId: string) {
  const a = actorOf(caller);
  const row = await rowFor(deps.db, a, transcriptId);
  if (row.status !== 'ready') throw new AppError('ai_recording_not_ready');
  if (row.pageNodeId) {
    const ok = await loadNode(deps.db, a, row.pageNodeId).then(
      () => true,
      () => false,
    );
    if (ok) return toTranscriptView(row);
  }
  const [r] = await deps.db.select().from(recordings).where(eq(recordings.id, row.recordingId));
  const [m] = await deps.db.select().from(meetings).where(eq(meetings.id, row.meetingId));
  if (!r?.nodeId || !m) throw new AppError('not_found');
  await writeNotesPage(deps, a, row, {
    title: m.title,
    date: r.startedAt,
    nodeId: r.nodeId,
    locale: localeOf(caller.org),
  });
  return toTranscriptView((await transcriptOf(deps.db, row.recordingId))!);
}

/** "Panoya kart aç": one action item as a card; the board's own rules decide who may. */
export async function createActionCard(
  deps: Deps,
  caller: AiCaller,
  transcriptId: string,
  index: number,
  input: { boardId: string; columnId?: string | undefined },
  req: RequestInfo,
) {
  const a = actorOf(caller);
  const row = await rowFor(deps.db, a, transcriptId);
  const actions = actionsOf(row);
  const item = actions[index];
  if (!item) throw new AppError('not_found');
  if (item.cardId) return toTranscriptView(row);
  let columnId = input.columnId;
  if (!columnId) {
    const [first] = await deps.db
      .select({ id: boardColumns.id })
      .from(boardColumns)
      .where(eq(boardColumns.boardNodeId, input.boardId))
      .orderBy(asc(boardColumns.position))
      .limit(1);
    if (!first) throw new AppError('not_found');
    columnId = first.id;
  }
  const [m] = await deps.db.select().from(meetings).where(eq(meetings.id, row.meetingId));
  const description = [item.owner, m?.title].filter(Boolean).join(' · ');
  const card = await inBoardsTx(deps, (tx) =>
    createCard(
      tx,
      a,
      input.boardId,
      CreateBoardCard.parse({
        columnId,
        title: item.title,
        description,
        dueAt: item.due ? new Date(`${item.due}T09:00:00Z`).toISOString() : null,
      }),
    ),
  );
  actions[index] = { ...item, cardId: card.id, boardId: input.boardId, cardNumber: card.number };
  await setStatus(deps.db, row.id, { actions });
  await aiAudit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'ai.suggestion.accept',
      targetType: 'card',
      targetId: card.id,
      meta: { action: 'meeting_notes', transcriptId: row.id },
      via: { kind: 'ai', runId: row.runId },
    },
    req,
  );
  const [fresh] = await deps.db
    .select()
    .from(meetingTranscripts)
    .where(eq(meetingTranscripts.id, row.id));
  return toTranscriptView(fresh!);
}
