import { z } from 'zod';
import { Id, Locale, Timestamp } from './common';

/*
 * AI module A1 "Yazma yardımı" (yol haritası #5): writing help in the editor (summarize,
 * rewrite in a tone, translate TR/EN, continue) and "summarize unread" in chat. The org picks the
 * model: the Claude API or its own OpenAI-compatible server. The API key is stored encrypted and
 * never returned. Monthly token quotas per person and per org; every run is recorded and audited
 * with `via: { kind: 'ai' }`.
 *
 * Privacy: only text the caller may see reaches the model. Editor text names its source (a node
 * the caller can view, checked with `can()`, or the caller's own draft); chat summaries are built
 * on the server from the messages the caller can see. Vault content never goes to a model.
 */

// ---------------------------------------------------------------------------------------
// Paths outside the contract table
// ---------------------------------------------------------------------------------------

/**
 * Raw routes of the AI module, on the api origin.
 *
 * `stream` — POST, body `AiRunRequest`, answers `text/event-stream`. Each event is one
 * `data: <AiStreamEvent JSON>` line followed by a blank line: `start`, any number of `delta`,
 * then `done` or `error`. Errors before the stream opens (validation, quota, module off) answer
 * with the usual JSON error body and status. Same session, org and 2FA rules as the contract
 * endpoints; not callable with personal tokens. Clients that cannot read a streamed body (React
 * Native fetch) use `runAi`, which returns the whole text at once.
 */
export const AI_RAW_PATHS = {
  stream: '/api/v1/ai/stream',
  /** POST, body `AiAskRequest`: like `stream`, with a `citations` event before the answer. */
  ask: '/api/v1/ai/ask/stream',
  /**
   * POST, body: the recorded audio (Content-Type audio/webm, audio/ogg, audio/mp4 …, at most
   * `AI_LIMITS.dictationBytes`, about `dictationSeconds` long). Answers `AiTranscription`. Sesle
   * yazma where the browser has no speech recognition; needs the org's speech server.
   */
  transcribe: '/api/v1/ai/transcribe',
} as const;

// ---------------------------------------------------------------------------------------
// Limits and enums
// ---------------------------------------------------------------------------------------

export const AI_LIMITS = {
  /** Selected text sent with an editor action. */
  inputChars: 20_000,
  /** Unread chat messages one summary reads (the newest ones when there are more). */
  unreadMessages: 200,
  /** Upper bound of a single answer. */
  maxOutputTokens: 4_096,
  apiKeyChars: 500,
  modelChars: 200,
  /** Largest monthly quota an admin can set (per person or org). */
  maxMonthlyTokens: 1_000_000_000,
  questionChars: 2_000,
  /** Earlier question/answer pairs sent with a follow-up question. */
  askHistory: 4,
  /** Earlier turns "Yap" sends with a request. */
  actHistory: 6,
  /** Sources given to the model for one answer. */
  askSources: 8,
  searchResults: 30,
  /** Longest dictation recording, in seconds, and its size. */
  dictationSeconds: 60,
  dictationBytes: 5 * 1024 * 1024,
} as const;

/**
 * Model providers an org can pick. `openai_compatible` is any server speaking the OpenAI
 * chat-completions protocol (Ollama, vLLM, LiteLLM, Groq …); the others are hosted services.
 */
export const AI_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'mistral',
  'azure_openai',
  'openrouter',
  'openai_compatible',
] as const;
export const AiProvider = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof AiProvider>;

/** Model used for `anthropic` when the admin has not picked one. */
export const AI_DEFAULT_MODEL = 'claude-opus-5-5';

/** Azure OpenAI `api-version` used when the admin leaves it empty. */
export const AZURE_DEFAULT_API_VERSION = '2024-10-21';

/** What the settings form asks for, per provider (clients and server read the same table). */
export interface AiProviderInfo {
  /** Model (Azure: deployment name) used when the admin leaves it empty. */
  defaultModel: string;
  /** Suggestions for the model field; any other name is accepted. */
  models: readonly string[];
  /**
   * `fixed`: the provider's own address (`defaultBaseUrl`); an override is allowed for a gateway
   * or proxy. `required`: the admin enters it (own server, Azure resource).
   */
  baseUrl: 'fixed' | 'required';
  defaultBaseUrl: string | null;
  apiKey: 'required' | 'optional';
  /** Azure OpenAI: `model` is the deployment name, plus an `api-version`. */
  apiVersion: boolean;
  /** Has an embeddings endpoint (semantic search in "Crewhall'a sor"). */
  embeddings: boolean;
  defaultEmbeddingModel: string | null;
  /** Suggested "Hızlı model" (null: none to suggest). */
  fastModel: string | null;
}

export const AI_PROVIDER_INFO: Record<AiProvider, AiProviderInfo> = {
  anthropic: {
    defaultModel: AI_DEFAULT_MODEL,
    models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    baseUrl: 'fixed',
    defaultBaseUrl: null,
    apiKey: 'required',
    apiVersion: false,
    embeddings: false,
    defaultEmbeddingModel: null,
    fastModel: 'claude-haiku-5-5',
  },
  openai: {
    defaultModel: 'gpt-5-mini',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini'],
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKey: 'required',
    apiVersion: false,
    embeddings: true,
    defaultEmbeddingModel: 'text-embedding-3-small',
    fastModel: 'gpt-5-nano',
  },
  gemini: {
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'required',
    apiVersion: false,
    embeddings: true,
    defaultEmbeddingModel: 'gemini-embedding-001',
    fastModel: 'gemini-2.5-flash-lite',
  },
  mistral: {
    defaultModel: 'mistral-medium-latest',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    apiKey: 'required',
    apiVersion: false,
    embeddings: true,
    defaultEmbeddingModel: 'mistral-embed',
    fastModel: 'mistral-small-latest',
  },
  azure_openai: {
    defaultModel: 'gpt-4.1-mini',
    models: [],
    baseUrl: 'required',
    defaultBaseUrl: null,
    apiKey: 'required',
    apiVersion: true,
    embeddings: true,
    defaultEmbeddingModel: null,
    fastModel: null,
  },
  openrouter: {
    defaultModel: 'openai/gpt-5-mini',
    models: [
      'openai/gpt-5-mini',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-flash',
      'mistralai/mistral-medium-3.1',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'required',
    apiVersion: false,
    embeddings: false,
    defaultEmbeddingModel: null,
    fastModel: null,
  },
  openai_compatible: {
    defaultModel: 'llama3.3',
    models: [],
    baseUrl: 'required',
    defaultBaseUrl: null,
    apiKey: 'optional',
    apiVersion: false,
    embeddings: true,
    defaultEmbeddingModel: null,
    fastModel: null,
  },
};

export const AI_TONES = ['professional', 'friendly', 'concise', 'simple', 'formal'] as const;
export const AiTone = z.enum(AI_TONES);
export type AiTone = z.infer<typeof AiTone>;

export const AI_ACTIONS = [
  'summarize',
  'rewrite',
  'translate',
  'continue',
  'summarize_unread',
  'ask',
  'meeting_notes',
  'act',
  'automation',
  /** Sesle yazma through the org's speech server. */
  'dictate',
] as const;
export const AiAction = z.enum(AI_ACTIONS);
export type AiAction = z.infer<typeof AiAction>;

// ---------------------------------------------------------------------------------------
// Running an action
// ---------------------------------------------------------------------------------------

/**
 * Where editor text comes from. `node`: a Drive node (wiki page …) the caller can view; the
 * server checks it with `can()` and records it as the run's target. `draft`: text the caller is
 * writing that is not stored anywhere yet (a quick note, a message being composed).
 */
export const AiSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), nodeId: Id }),
  z.object({ kind: z.literal('draft') }),
]);
export type AiSource = z.infer<typeof AiSource>;

const EditorText = z.string().trim().min(1).max(AI_LIMITS.inputChars);

export const AiRunRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('summarize'), text: EditorText, source: AiSource }),
  z.object({
    action: z.literal('rewrite'),
    text: EditorText,
    tone: AiTone,
    source: AiSource,
  }),
  z.object({
    action: z.literal('translate'),
    text: EditorText,
    targetLang: Locale,
    source: AiSource,
  }),
  /** `text`: what comes before the caret (the client sends the last few thousand characters). */
  z.object({ action: z.literal('continue'), text: EditorText, source: AiSource }),
  /**
   * The caller's unread messages in the conversation (after their read position, within the
   * history they can see), summarized in `locale` (default: Accept-Language, then tr).
   */
  z.object({
    action: z.literal('summarize_unread'),
    conversationId: Id,
    locale: Locale.optional(),
    /**
     * Count from this read position instead of the stored one: the client's "Yeni mesajlar"
     * divider, since opening the conversation already moved the stored position forward.
     */
    afterSeq: z.number().int().min(0).optional(),
  }),
]);
export type AiRunRequest = z.infer<typeof AiRunRequest>;

export const AiUsage = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type AiUsage = z.infer<typeof AiUsage>;

export const AiRunResult = z.object({
  /** Pass to `acceptAiRun` when the person keeps the result. Null when no model was called. */
  runId: Id.nullable(),
  text: z.string(),
  usage: AiUsage,
  /** The answer hit the length limit. */
  truncated: z.boolean(),
  /** summarize_unread: how many messages were read (0 = nothing unread, no model call). */
  messages: z.number().int().min(0).optional(),
});
export type AiRunResult = z.infer<typeof AiRunResult>;

// ---------------------------------------------------------------------------------------
// Search and "Crewhall'a sor" (yol haritası #11)
// ---------------------------------------------------------------------------------------

export const AI_SEARCH_KINDS = [
  'page',
  'file',
  'folder',
  'board',
  'drawing',
  'card',
  'message',
  // Live data the assistant reads with its tools ("Crewhall'a sor"); not in the search index.
  /** A calendar event. */
  'event',
  /** A scheduled or a past meeting. */
  'meeting',
  /** An item on one of the person's to-do cards on the home page. */
  'todo',
  /** A colleague from the directory. */
  'person',
  /** An outside contact (Rehber). */
  'contact',
  /** A message in the person's mail inbox. */
  'mail',
  /** A row of a space table (Tablolar). */
  'row',
] as const;
export const AiSearchKind = z.enum(AI_SEARCH_KINDS);
export type AiSearchKind = z.infer<typeof AiSearchKind>;

export const AiSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  /** Comma-separated AiSearchKind values; default all. */
  kinds: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(',').filter((k) => AiSearchKind.safeParse(k).success) : []))
    .pipe(z.array(AiSearchKind)),
  limit: z.coerce.number().int().min(1).max(AI_LIMITS.searchResults).default(10),
});
export type AiSearchQuery = z.input<typeof AiSearchQuery>;

/**
 * One result the caller may open. Clients build the link from the kind: page → nodeId,
 * file/folder → nodeId + spaceId, board/drawing → nodeId, card → boardId + cardNumber,
 * message → conversationId + seq.
 */
export const AiSearchHit = z.object({
  kind: AiSearchKind,
  refId: Id,
  title: z.string(),
  snippet: z.string(),
  nodeId: Id.nullable(),
  spaceId: Id.nullable(),
  conversationId: Id.nullable(),
  seq: z.number().int().nullable(),
  boardId: Id.nullable(),
  cardNumber: z.number().int().nullable(),
  updatedAt: Timestamp,
  /** Live sources: the web path that opens the item (calendar day, meeting, person …). */
  path: z.string().nullable().optional(),
  /** Live sources: when it happens (event or meeting start, due date). */
  at: Timestamp.nullable().optional(),
});
export type AiSearchHit = z.infer<typeof AiSearchHit>;

/** A source of an answer; `n` is the number the answer cites as [n]. */
export const AiCitation = AiSearchHit.extend({ n: z.number().int().min(1) });
export type AiCitation = z.infer<typeof AiCitation>;

export const AiAskRequest = z.object({
  question: z.string().trim().min(1).max(AI_LIMITS.questionChars),
  /** Earlier turns of the same conversation with the assistant (newest last). */
  history: z
    .array(
      z.object({
        question: z.string().max(AI_LIMITS.questionChars),
        answer: z.string().max(8_000),
      }),
    )
    .max(AI_LIMITS.askHistory)
    .default([]),
  locale: Locale.optional(),
  /** IANA time zone of the person: "yarın", "bu hafta" are read in it. Default UTC. */
  timeZone: z.string().max(64).optional(),
});
export type AiAskRequest = z.input<typeof AiAskRequest>;

export const AiAskResult = z.object({
  runId: Id.nullable(),
  answer: z.string(),
  citations: z.array(AiCitation),
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
  truncated: z.boolean(),
});
export type AiAskResult = z.infer<typeof AiAskResult>;

/** Text of a dictation recording (AI_RAW_PATHS.transcribe). */
export const AiTranscription = z.object({
  text: z.string(),
  language: z.string().nullable(),
});
export type AiTranscription = z.infer<typeof AiTranscription>;

export const AiIndexStatus = z.object({
  chunks: z.number().int().min(0),
  documents: z.number().int().min(0),
  embedded: z.number().int().min(0),
  /** Semantic search: an embedding model is set (OpenAI-compatible servers). */
  embeddings: z.boolean(),
  /** How vectors are compared: the pgvector extension, plain arrays, or not at all. */
  vector: z.enum(['pgvector', 'array', 'off']),
  lastIndexedAt: Timestamp.nullable(),
});
export type AiIndexStatus = z.infer<typeof AiIndexStatus>;

export const AiStreamEvent = z.discriminatedUnion('type', [
  /** Ask only: the sources, before the answer starts. */
  z.object({ type: z.literal('citations'), citations: z.array(AiCitation) }),
  z.object({
    type: z.literal('start'),
    runId: Id.nullable(),
    messages: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    runId: Id.nullable(),
    usage: AiUsage,
    truncated: z.boolean(),
  }),
  /** `code` is an error code (`errors.<code>`), e.g. ai_provider_error. */
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type AiStreamEvent = z.infer<typeof AiStreamEvent>;

// ---------------------------------------------------------------------------------------
// Status for every member
// ---------------------------------------------------------------------------------------

export const AiQuotaBucket = z.object({
  usedTokens: z.number().int().min(0),
  /** null = unlimited. */
  limitTokens: z.number().int().positive().nullable(),
});
export type AiQuotaBucket = z.infer<typeof AiQuotaBucket>;

export const AiStatus = z.object({
  /** The AI buttons work right now. */
  available: z.boolean(),
  /** Why not: switched off by the admin, no provider/key yet, or the monthly quota is used up. */
  reason: z.enum(['disabled', 'not_configured', 'quota']).nullable(),
  provider: AiProvider.nullable(),
  model: z.string().nullable(),
  /** The org has a speech server: dictation works where the browser has no speech recognition. */
  dictation: z.boolean().optional(),
  quota: z.object({
    /** Calendar month in UTC, `YYYY-MM`. */
    month: z.string(),
    resetsAt: Timestamp,
    user: AiQuotaBucket,
    org: AiQuotaBucket,
  }),
});
export type AiStatus = z.infer<typeof AiStatus>;

// ---------------------------------------------------------------------------------------
// Yönetim › Yapay zekâ (owner, admin)
// ---------------------------------------------------------------------------------------

export const AiTestResult = z.object({
  ok: z.boolean(),
  at: Timestamp,
  latencyMs: z.number().int().min(0).nullable(),
  /** The provider's message on failure (never contains the key). */
  error: z.string().nullable(),
});
export type AiTestResult = z.infer<typeof AiTestResult>;

const MonthlyTokens = z.number().int().positive().max(AI_LIMITS.maxMonthlyTokens).nullable();

export const AiSettings = z.object({
  enabled: z.boolean(),
  provider: AiProvider,
  model: z.string(),
  /**
   * Own servers: the base URL up to `/v1` (e.g. `http://llm.local:8000/v1`); Azure: the resource
   * endpoint (`https://<name>.openai.azure.com`); hosted providers: null or a gateway override.
   */
  baseUrl: z.string().nullable(),
  /** Azure OpenAI `api-version`; null elsewhere. */
  apiVersion: z.string().nullable(),
  /** The key itself is never returned; `hint` shows its last four characters. */
  apiKey: z.object({
    set: z.boolean(),
    hint: z.string().nullable(),
    updatedAt: Timestamp.nullable(),
  }),
  /** Provider and key are complete (the OpenAI-compatible provider may run without a key). */
  configured: z.boolean(),
  orgMonthlyTokens: MonthlyTokens,
  userMonthlyTokens: MonthlyTokens,
  /** Semantic search (OpenAI-compatible `/embeddings`); null = full-text search only. */
  embeddingModel: z.string().nullable(),
  /**
   * "Hızlı model": a cheaper model of the same provider for short structured steps (the Ask
   * tool choice, "Yap" plans). Null = everything runs on `model`. Optional in responses for older
   * servers.
   */
  fastModel: z.string().nullable().optional(),
  /**
   * Speech-to-text server for meeting notes: OpenAI-compatible `/audio/transcriptions` (e.g.
   * faster-whisper behind speaches, `docker/compose.yml` profile `ai`). Its key is the org key
   * only when it is the same server as `baseUrl`.
   */
  transcriptionUrl: z.string().nullable(),
  transcriptionModel: z.string().nullable(),
  /** Transcribe and summarize every recording into a meeting-notes page automatically. */
  meetingNotes: z.boolean(),
  lastTest: AiTestResult.nullable(),
  updatedAt: Timestamp.nullable(),
});
export type AiSettings = z.infer<typeof AiSettings>;

const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((u) => u.replace(/\/+$/, ''));

const ApiVersion = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/);

export const UpdateAiSettings = z.object({
  enabled: z.boolean().optional(),
  provider: AiProvider.optional(),
  model: z.string().trim().min(1).max(AI_LIMITS.modelChars).optional(),
  baseUrl: BaseUrl.nullable().optional(),
  /** A new key; null removes the stored one. Omit to keep it. */
  apiKey: z.string().trim().min(1).max(AI_LIMITS.apiKeyChars).nullable().optional(),
  orgMonthlyTokens: MonthlyTokens.optional(),
  userMonthlyTokens: MonthlyTokens.optional(),
  embeddingModel: z.string().trim().min(1).max(AI_LIMITS.modelChars).nullable().optional(),
  fastModel: z.string().trim().min(1).max(AI_LIMITS.modelChars).nullable().optional(),
  transcriptionUrl: BaseUrl.nullable().optional(),
  transcriptionModel: z.string().trim().min(1).max(AI_LIMITS.modelChars).nullable().optional(),
  meetingNotes: z.boolean().optional(),
  apiVersion: ApiVersion.nullable().optional(),
});
export type UpdateAiSettings = z.infer<typeof UpdateAiSettings>;

/**
 * Tests the stored settings, or the values given here before saving them (a key typed into the
 * form; omitted fields fall back to the stored ones). Sends one tiny request to the model.
 */
export const TestAiSettings = z.object({
  provider: AiProvider.optional(),
  model: z.string().trim().min(1).max(AI_LIMITS.modelChars).optional(),
  baseUrl: BaseUrl.nullable().optional(),
  apiKey: z.string().trim().min(1).max(AI_LIMITS.apiKeyChars).optional(),
  apiVersion: ApiVersion.nullable().optional(),
});
export type TestAiSettings = z.infer<typeof TestAiSettings>;

export const AiUsageQuery = z.object({
  /** `YYYY-MM` (UTC); default the current month. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});
export type AiUsageQuery = z.infer<typeof AiUsageQuery>;

const UsageTotals = z.object({
  runs: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  /** Part of inputTokens the provider served from its prompt cache (billed at ~10%). */
  cachedInputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0),
});

export const AiUsageReport = z.object({
  month: z.string(),
  totals: UsageTotals,
  days: z.array(UsageTotals.extend({ date: z.string() })),
  byAction: z.array(UsageTotals.extend({ action: AiAction })),
  byUser: z.array(
    UsageTotals.extend({
      user: z.object({ id: Id, name: z.string(), imageUrl: z.string().nullable() }),
    }),
  ),
});
export type AiUsageReport = z.infer<typeof AiUsageReport>;

// ---------------------------------------------------------------------------------------
// Toplantı asistanı (yol haritası #12)
// ---------------------------------------------------------------------------------------

export const MeetingTranscriptStatus = z.enum([
  'queued',
  'transcribing',
  'summarizing',
  'ready',
  'failed',
]);
export type MeetingTranscriptStatus = z.infer<typeof MeetingTranscriptStatus>;

/** An action item from the summary; `cardId` once it was turned into a board card. */
export const MeetingAction = z.object({
  title: z.string(),
  owner: z.string().nullable(),
  /** YYYY-MM-DD when the meeting named a date. */
  due: z.string().nullable(),
  cardId: Id.nullable(),
  boardId: Id.nullable(),
  cardNumber: z.number().int().nullable(),
});
export type MeetingAction = z.infer<typeof MeetingAction>;

/**
 * Transcript, summary, decisions and action items of one recording. Visible to whoever can open
 * the recording file in Drive.
 */
export const MeetingTranscript = z.object({
  id: Id,
  recordingId: Id,
  meetingId: Id,
  status: MeetingTranscriptStatus,
  /** An error code (errors.<code>) when failed. */
  error: z.string().nullable(),
  language: z.string().nullable(),
  text: z.string().nullable(),
  summary: z.string().nullable(),
  decisions: z.array(z.string()),
  actions: z.array(MeetingAction),
  /** The meeting-notes page, once written. */
  pageNodeId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type MeetingTranscript = z.infer<typeof MeetingTranscript>;

export const MeetingTranscriptState = z.object({
  /** A speech server is set up and AI is on: "Dökümü çıkar" can run. */
  available: z.boolean(),
  transcript: MeetingTranscript.nullable(),
});
export type MeetingTranscriptState = z.infer<typeof MeetingTranscriptState>;

export const CreateMeetingActionCard = z.object({
  boardId: Id,
  /** Default: the board's first column. */
  columnId: Id.optional(),
});
export type CreateMeetingActionCard = z.infer<typeof CreateMeetingActionCard>;

// ---------------------------------------------------------------------------------------
// Eylem yapan asistan (yol haritası #18)
// ---------------------------------------------------------------------------------------

export const AI_ACT_KINDS = [
  'assign_card',
  'create_card',
  'create_meeting',
  /** An item on one of the person's own to-do cards on the home page (Benim). */
  'add_todo_item',
  /** An entry in the person's own calendar (not a video meeting: that is create_meeting). */
  'create_event',
  /** A chat message in the person's name, to a colleague or a group/channel. */
  'send_message',
  /** A new wiki page, in a space the person names or their own. */
  'create_page',
  /** A note added at the end of a page the person may edit. */
  'append_page',
  /** A to-do card's real items, carried to a new or existing page. */
  'todo_to_page',
  /** A page's real list items, carried to a to-do card or a board. */
  'page_to_tasks',
  /** Items moved from one of the person's to-do cards to another. */
  'move_todo_items',
] as const;
export const AiActKind = z.enum(AI_ACT_KINDS);
export type AiActKind = z.infer<typeof AiActKind>;

/**
 * One proposed action, waiting in the approval queue (Hesabım › Onay bekleyenler). Nothing is
 * done until the person approves it there.
 */
export const AiActProposal = z.object({
  approvalId: Id,
  kind: AiActKind,
  title: z.string(),
  detail: z.string().nullable(),
});
export type AiActProposal = z.infer<typeof AiActProposal>;

/** An earlier turn of the conversation, sent back so "evet" and "saatini 11 yap" have a meaning. */
export const AiActTurn = z.object({
  request: z.string().max(1_000),
  message: z.string().max(4_000),
  proposals: z.array(AiActProposal).max(20).default([]),
  skipped: z.array(z.string().max(1_000)).max(20).default([]),
});
export type AiActTurn = z.input<typeof AiActTurn>;

export const AiActRequest = z.object({
  /** "MLV-142 kartına beni ata", "yarın 10'a Elif ve Can ile toplantı kur" … */
  request: z.string().trim().min(1).max(1_000),
  /** IANA time zone of the person (dates like "yarın 10:00" are read in it). Default UTC. */
  timeZone: z.string().max(64).optional(),
  locale: Locale.optional(),
  /** The conversation so far, oldest first. Absent: the request stands alone. */
  history: z.array(AiActTurn).max(AI_LIMITS.actHistory).optional(),
});
export type AiActRequest = z.input<typeof AiActRequest>;

export const AiActResult = z.object({
  runId: Id.nullable(),
  /** The assistant's short answer (what it proposes, or why it cannot). */
  message: z.string(),
  proposals: z.array(AiActProposal),
  /** Actions it understood but could not prepare (unknown card, no right …), as sentences. */
  skipped: z.array(z.string()),
  /**
   * Earlier proposals this message decides ("evet", "vazgeçtim", or a corrected version). The server
   * changes nothing itself: the client presses the same approve and reject buttons, passkey or
   * password check included. Absent from servers before API level 35.
   */
  decided: z.object({ approve: z.array(Id), reject: z.array(Id) }).optional(),
});
export type AiActResult = z.infer<typeof AiActResult>;
