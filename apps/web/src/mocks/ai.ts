import {
  AI_DEFAULT_MODEL,
  AI_PROVIDER_INFO,
  AI_RAW_PATHS,
  AiAskRequest,
  AiRunRequest,
  type AiRunResult,
  type AiSettings,
  type AiStatus,
  type AiCitation,
  type MeetingTranscript,
  type AiSearchHit,
  type AiStreamEvent,
  type EndpointName,
} from '@crewhall/shared';
import { http, HttpResponse } from 'msw';
import { actorOf, MockApiError, requireUser, type Resolvers } from './core';
import { db, newId } from './db';
import { driveState, nodeForUser } from './drive';
import { mcpMockState } from './mcp';
import { enabledModulesOf } from './identity';
import { type MockState } from './seed';

/**
 * AI part of the contract mock (yol haritası #5). No model: answers are made up from the input so
 * the editor and chat flows can be tried with `dev:mock`. State lives in memory (resets on reload).
 */

interface MockAi {
  settings: AiSettings;
  used: Map<string, number>;
  runs: { id: string; userId: string; action: string; tokens: number; accepted: boolean }[];
  transcripts: Map<string, MeetingTranscript>;
}

const initial = (): MockAi => ({
  settings: {
    enabled: true,
    provider: 'anthropic',
    model: AI_DEFAULT_MODEL,
    baseUrl: null,
    apiVersion: null,
    apiKey: { set: true, hint: 'demo', updatedAt: new Date().toISOString() },
    configured: true,
    orgMonthlyTokens: null,
    userMonthlyTokens: 200_000,
    embeddingModel: null,
    fastModel: null,
    transcriptionUrl: 'http://whisper:8000/v1',
    transcriptionModel: 'Systran/faster-whisper-small',
    meetingNotes: false,
    lastTest: null,
    updatedAt: new Date().toISOString(),
  },
  used: new Map(),
  runs: [],
  transcripts: new Map(),
});

let ai = initial();

/** Tests: back to the seeded settings, no runs. */
export function resetAiMock(): void {
  ai = initial();
}

/** Tests: the mock state, to check what the UI changed. */
export const aiMockState = () => ai;

function monthBounds() {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { month: now.toISOString().slice(0, 7), resetsAt: to.toISOString() };
}

function requireAdmin(s: MockState) {
  const role = actorOf(s, requireUser(s)).orgRole;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
}

function status(s: MockState): AiStatus {
  const u = requireUser(s);
  const used = ai.used.get(u.id) ?? 0;
  const orgUsed = [...ai.used.values()].reduce((a, b) => a + b, 0);
  const st = ai.settings;
  const over =
    (st.userMonthlyTokens !== null && used >= st.userMonthlyTokens) ||
    (st.orgMonthlyTokens !== null && orgUsed >= st.orgMonthlyTokens);
  const reason = !st.enabled
    ? 'disabled'
    : !st.configured
      ? 'not_configured'
      : over
        ? 'quota'
        : null;
  return {
    available: reason === null,
    reason,
    provider: st.enabled ? st.provider : null,
    model: st.enabled ? st.model : null,
    dictation: st.enabled && !!st.transcriptionUrl && !!st.transcriptionModel,
    quota: {
      ...monthBounds(),
      user: { usedTokens: used, limitTokens: st.userMonthlyTokens },
      org: { usedTokens: orgUsed, limitTokens: st.orgMonthlyTokens },
    },
  };
}

/** A made-up answer shaped like the real one. */
function answer(req: AiRunRequest): string {
  if (req.action === 'summarize_unread') {
    return '- Sürüm cuma 17:00’de çıkıyor.\n- Senden test raporu bekleniyor (perşembe).\n- Toplantı notları sayfaya eklendi.';
  }
  const text = req.text.replace(/\s+/g, ' ').trim();
  switch (req.action) {
    case 'summarize':
      return `Özet: ${text.split(/(?<=[.!?])\s/)[0]?.slice(0, 160) ?? text}`;
    case 'rewrite':
      return `${text.charAt(0).toUpperCase()}${text.slice(1)}`.replace(/\s*$/, '');
    case 'translate':
      return req.targetLang === 'en' ? `(EN) ${text}` : `(TR) ${text}`;
    case 'continue':
      return 'Bu adımlar tamamlandığında ekip bir sonraki aşamaya geçebilir ve sonuçlar haftalık toplantıda paylaşılır.';
  }
}

function startRun(s: MockState, body: AiRunRequest) {
  const st = status(s);
  if (st.reason === 'disabled') throw new MockApiError('ai_disabled');
  if (st.reason === 'not_configured') throw new MockApiError('ai_not_configured');
  if (st.reason === 'quota') throw new MockApiError('ai_quota_exceeded');
  const u = requireUser(s);
  const text = answer(body);
  const usage = {
    inputTokens: Math.ceil(('text' in body ? body.text.length : 2000) / 4) + 80,
    outputTokens: Math.ceil(text.length / 4),
  };
  const id = newId();
  ai.runs.push({
    id,
    userId: u.id,
    action: body.action,
    tokens: usage.inputTokens + usage.outputTokens,
    accepted: false,
  });
  ai.used.set(u.id, (ai.used.get(u.id) ?? 0) + usage.inputTokens + usage.outputTokens);
  return { id, text, usage };
}

/** Drive nodes (pages, files, folders, boards) whose name matches, as the person sees them. */
export function searchHits(s: MockState, q: string, limit: number): AiSearchHit[] {
  const u = requireUser(s);
  const words = q
    .toLocaleLowerCase('tr')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const out: AiSearchHit[] = [];
  for (const n of driveState(s).nodes) {
    if (out.length >= limit) break;
    const name = n.name.toLocaleLowerCase('tr');
    if (!words.some((w) => name.includes(w.slice(0, 4)))) continue;
    const node = nodeForUser(s, n.id, u.id);
    if (!node) continue;
    out.push({
      kind: node.type,
      refId: node.id,
      title: node.name,
      snippet: node.name,
      nodeId: node.id,
      spaceId: node.spaceId,
      conversationId: null,
      seq: null,
      boardId: null,
      cardNumber: null,
      updatedAt: node.updatedAt,
    });
  }
  return out;
}

function askAnswer(citations: AiCitation[]) {
  return citations.length
    ? `Bulduğum içeriğe göre: ${citations
        .slice(0, 3)
        .map((c) => `${c.title} [${c.n}]`)
        .join(', ')}.`
    : 'Bu soruya uyan bir içerik bulamadım. Başka kelimelerle aramayı dene.';
}

const indexStatus = () => ({
  chunks: 42,
  documents: 30,
  embedded: ai.settings.embeddingModel ? 42 : 0,
  embeddings: ai.settings.embeddingModel !== null,
  vector: ai.settings.embeddingModel ? ('array' as const) : ('off' as const),
  lastIndexedAt: new Date().toISOString(),
});

/** A made-up transcript of a recording, ready at once. */
function mockTranscript(recordingId: string): MeetingTranscript {
  const now = new Date().toISOString();
  return {
    id: newId(),
    recordingId,
    meetingId: newId(),
    status: 'ready',
    error: null,
    language: 'tr',
    text: 'Merhaba. Sürüm cuma 17:00de çıkıyor. Elif test raporunu perşembeye hazırlayacak. Can sürüm notlarını yazacak.',
    summary: '- Sürüm cuma 17:00de çıkıyor.\n- Test raporu perşembeye hazır olacak.',
    decisions: ['Sürüm cuma 17:00de çıkacak'],
    actions: [
      {
        title: 'Test raporunu hazırla',
        owner: 'Elif',
        due: null,
        cardId: null,
        boardId: null,
        cardNumber: null,
      },
      {
        title: 'Sürüm notlarını yaz',
        owner: 'Can',
        due: null,
        cardId: null,
        boardId: null,
        cardNumber: null,
      },
    ],
    pageNodeId: null,
    createdAt: now,
    updatedAt: now,
  };
}

const transcriptState = (recordingId: string) => ({
  available: ai.settings.enabled && ai.settings.transcriptionUrl !== null,
  transcript: ai.transcripts.get(recordingId) ?? null,
});

/** A made-up proposal in the MCP mock's approval queue for "Yap" mode. */
function proposeAction(s: MockState, request: string) {
  const u = requireUser(s);
  const id = newId();
  const now = Date.now();
  const title = request.length > 60 ? `${request.slice(0, 59)}…` : request;
  mcpMockState(s).approvals.unshift({
    id,
    userId: u.id,
    action: 'ai.action',
    tool: 'ai_create_card',
    title: `Kart aç: ${title}`,
    target: title,
    itemCount: 1,
    via: { kind: 'token', name: 'Crewhall AI', grantId: null, tokenId: null },
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    decidedAt: null,
    clientNote: request,
    items: [{ kind: 'create_card', label: title, detail: null, location: 'Sürüm' }],
    payload: { title },
    decidedBy: null,
    errorCode: null,
  });
  return { approvalId: id, kind: 'create_card' as const, title, detail: null };
}

export const aiResolvers: Partial<Resolvers<EndpointName>> = {
  planAiActions: ({ s, body }) => {
    // "Evet" to what the last turn prepared: the server decides, the client presses the buttons.
    const waiting = body.history?.at(-1)?.proposals.map((p) => p.approvalId) ?? [];
    if (waiting.length && /^(evet|yap|tamam|yes)$/i.test(body.request.trim())) {
      return {
        runId: null,
        message: 'Onayını aldım, uyguluyorum.',
        proposals: [],
        skipped: [],
        decided: { approve: waiting, reject: [] },
      };
    }
    // "A ve B": a plan of several steps, as the assistant plans a whole request.
    const proposals = body.request.split(' ve ').map((part) => proposeAction(s, part));
    return {
      runId: newId(),
      message: 'Hazırladığım işlem onayını bekliyor.',
      proposals,
      skipped: [],
    };
  },
  getMeetingTranscript: ({ s, params }) => {
    requireUser(s);
    return transcriptState(params.recordingId!);
  },
  startMeetingTranscript: ({ s, params }) => {
    requireUser(s);
    if (!ai.settings.transcriptionUrl) throw new MockApiError('ai_transcription_not_configured');
    ai.transcripts.set(params.recordingId!, mockTranscript(params.recordingId!));
    return transcriptState(params.recordingId!);
  },
  createMeetingActionCard: ({ s, params, body }) => {
    requireUser(s);
    const t = [...ai.transcripts.values()].find((x) => x.id === params.transcriptId);
    const action = t?.actions[Number(params.index)];
    if (!t || !action) throw new MockApiError('not_found');
    action.cardId ??= newId();
    action.boardId = body.boardId;
    action.cardNumber ??= 100 + Number(params.index);
    return t;
  },
  createMeetingNotesPage: ({ s, params }) => {
    requireUser(s);
    const t = [...ai.transcripts.values()].find((x) => x.id === params.transcriptId);
    if (!t) throw new MockApiError('not_found');
    return t;
  },
  searchAi: ({ s, query }) => ({ items: searchHits(s, query.q, query.limit) }),
  askAi: ({ s, body }) => {
    const citations = searchHits(s, body.question, 8).map((h, i) => ({ ...h, n: i + 1 }));
    const run = startRun(s, {
      action: 'summarize',
      text: body.question,
      source: { kind: 'draft' },
    });
    return {
      runId: run.id,
      answer: askAnswer(citations),
      citations,
      usage: run.usage,
      truncated: false,
    };
  },
  getAiIndexStatus: ({ s }) => {
    requireAdmin(s);
    return indexStatus();
  },
  rebuildAiIndex: ({ s }) => {
    requireAdmin(s);
    return indexStatus();
  },
  getAiStatus: ({ s }) => status(s),
  runAi: ({ s, body }): AiRunResult => {
    const run = startRun(s, body);
    return {
      runId: run.id,
      text: run.text,
      usage: run.usage,
      truncated: false,
      ...(body.action === 'summarize_unread' ? { messages: 3 } : {}),
    };
  },
  acceptAiRun: ({ s, params }) => {
    const u = requireUser(s);
    const run = ai.runs.find((r) => r.id === params.runId && r.userId === u.id && !r.accepted);
    if (!run) throw new MockApiError('ai_run_not_found');
    run.accepted = true;
    return {};
  },
  getAiSettings: ({ s }) => {
    requireAdmin(s);
    return ai.settings;
  },
  updateAiSettings: ({ s, body }) => {
    requireAdmin(s);
    const prev = ai.settings;
    const provider = body.provider ?? prev.provider;
    const info = AI_PROVIDER_INFO[provider];
    const providerChanged = provider !== prev.provider;
    const baseUrl =
      body.baseUrl !== undefined ? body.baseUrl : providerChanged ? null : prev.baseUrl;
    const endpointChanged =
      providerChanged ||
      (baseUrl !== prev.baseUrl && !(info.baseUrl === 'required' && prev.baseUrl === null));
    const apiKey =
      typeof body.apiKey === 'string'
        ? { set: true, hint: body.apiKey.slice(-4), updatedAt: new Date().toISOString() }
        : body.apiKey === null || endpointChanged
          ? { set: false, hint: null, updatedAt: null }
          : prev.apiKey;
    ai.settings = {
      ...prev,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.orgMonthlyTokens !== undefined ? { orgMonthlyTokens: body.orgMonthlyTokens } : {}),
      ...(body.embeddingModel !== undefined ? { embeddingModel: body.embeddingModel } : {}),
      ...(body.userMonthlyTokens !== undefined
        ? { userMonthlyTokens: body.userMonthlyTokens }
        : {}),
      provider,
      baseUrl,
      apiKey,
      model: body.model ?? (providerChanged ? info.defaultModel : prev.model),
      fastModel:
        body.fastModel !== undefined
          ? body.fastModel
          : providerChanged
            ? null
            : (prev.fastModel ?? null),
      apiVersion: info.apiVersion
        ? body.apiVersion !== undefined
          ? body.apiVersion
          : providerChanged
            ? null
            : prev.apiVersion
        : null,
      embeddingModel: !info.embeddings
        ? null
        : body.embeddingModel !== undefined
          ? body.embeddingModel
          : providerChanged
            ? info.defaultEmbeddingModel
            : prev.embeddingModel,
      configured:
        (info.apiKey === 'optional' || apiKey.set) &&
        (info.baseUrl === 'fixed' || baseUrl !== null),
      lastTest: endpointChanged ? null : prev.lastTest,
      updatedAt: new Date().toISOString(),
    };
    return ai.settings;
  },
  testAiSettings: ({ s, body }) => {
    requireAdmin(s);
    const key = body.apiKey ?? (ai.settings.apiKey.set ? 'stored' : null);
    const provider = body.provider ?? ai.settings.provider;
    const ok = provider === 'openai_compatible' || key !== null;
    const result = {
      ok,
      at: new Date().toISOString(),
      latencyMs: ok ? 420 : null,
      error: ok ? null : 'missing api key',
    };
    if (Object.keys(body).length === 0) ai.settings = { ...ai.settings, lastTest: result };
    return result;
  },
  getAiUsage: ({ s, query }) => {
    requireAdmin(s);
    const month = query.month ?? monthBounds().month;
    const runs = month === monthBounds().month ? ai.runs : [];
    const sum = (list: typeof runs) => ({
      runs: list.length,
      inputTokens: Math.round(list.reduce((a, r) => a + r.tokens, 0) * 0.8),
      outputTokens: Math.round(list.reduce((a, r) => a + r.tokens, 0) * 0.2),
    });
    const actions = [...new Set(runs.map((r) => r.action))];
    const people = [...new Set(runs.map((r) => r.userId))];
    return {
      month,
      totals: sum(runs),
      days: runs.length ? [{ date: new Date().toISOString().slice(0, 10), ...sum(runs) }] : [],
      byAction: actions.map((a) => ({
        action: a as AiRunRequest['action'],
        ...sum(runs.filter((r) => r.action === a)),
      })),
      byUser: people.flatMap((id) => {
        const u = s.users.find((x) => x.id === id);
        return u
          ? [
              {
                user: { id: u.id, name: u.name, imageUrl: u.imageUrl },
                ...sum(runs.filter((r) => r.userId === id)),
              },
            ]
          : [];
      }),
    };
  },
};

/** `AI_RAW_PATHS.stream`: the made-up answer in small pieces, like a model would send it. */
const streamHandler = http.post(`*${AI_RAW_PATHS.stream}`, async ({ request }) => {
  const s = db();
  const parsed = AiRunRequest.safeParse(await request.json());
  if (!parsed.success) {
    return HttpResponse.json({ code: 'validation_failed', message: 'invalid' }, { status: 422 });
  }
  let run: ReturnType<typeof startRun>;
  try {
    if (!enabledModulesOf(s).includes('ai')) throw new MockApiError('module_disabled');
    run = startRun(s, parsed.data);
  } catch (e) {
    const code = e instanceof MockApiError ? e.code : 'internal';
    return HttpResponse.json(
      { code, message: code },
      { status: code === 'unauthenticated' ? 401 : 409 },
    );
  }
  const pieces = run.text.match(/.{1,6}/gsu) ?? [];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AiStreamEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: 'start', runId: run.id });
      for (const text of pieces) {
        await new Promise((r) => setTimeout(r, 35));
        send({ type: 'delta', text });
      }
      send({ type: 'done', runId: run.id, usage: run.usage, truncated: false });
      controller.close();
    },
  });
  return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
});

/** `AI_RAW_PATHS.ask`: citations, then a made-up answer that cites them. */
const askHandler = http.post(`*${AI_RAW_PATHS.ask}`, async ({ request }) => {
  const s = db();
  const parsed = AiAskRequest.safeParse(await request.json());
  if (!parsed.success) {
    return HttpResponse.json({ code: 'validation_failed', message: 'invalid' }, { status: 422 });
  }
  const citations = searchHits(s, parsed.data.question, 8).map((h, i) => ({ ...h, n: i + 1 }));
  const text = askAnswer(citations);
  const runId = newId();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AiStreamEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: 'citations', citations });
      send({ type: 'start', runId });
      for (const piece of text.match(/.{1,6}/gsu) ?? []) {
        await new Promise((r) => setTimeout(r, 30));
        send({ type: 'delta', text: piece });
      }
      send({
        type: 'done',
        runId,
        usage: { inputTokens: 900, outputTokens: Math.ceil(text.length / 4) },
        truncated: false,
      });
      controller.close();
    },
  });
  return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
});

/** `AI_RAW_PATHS.transcribe`: a fixed sentence for any recording, like a speech server would. */
export const MOCK_DICTATION = 'Yarın toplantım var mı';
const transcribeHandler = http.post(`*${AI_RAW_PATHS.transcribe}`, async ({ request }) => {
  const st = ai.settings;
  if (!st.enabled) {
    return HttpResponse.json({ code: 'ai_disabled', message: 'off' }, { status: 409 });
  }
  if (!st.transcriptionUrl || !st.transcriptionModel) {
    return HttpResponse.json(
      { code: 'ai_transcription_not_configured', message: 'no speech server' },
      { status: 409 },
    );
  }
  const size = (await request.arrayBuffer()).byteLength;
  if (!size) {
    return HttpResponse.json({ code: 'validation_failed', message: 'empty' }, { status: 422 });
  }
  return HttpResponse.json({ text: MOCK_DICTATION, language: 'tr' });
});

export const aiRawHandlers = [streamHandler, askHandler, transcribeHandler];
