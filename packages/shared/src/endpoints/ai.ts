import { Empty, def, items, type EndpointDef } from '../endpoint-def';
import {
  AiActRequest,
  AiActResult,
  AiAskRequest,
  AiAskResult,
  AiIndexStatus,
  AiRunRequest,
  AiSearchHit,
  AiSearchQuery,
  AiRunResult,
  AiSettings,
  AiStatus,
  AiTestResult,
  AiUsageQuery,
  AiUsageReport,
  CreateMeetingActionCard,
  MeetingTranscript,
  MeetingTranscriptState,
  TestAiSettings,
  UpdateAiSettings,
} from '../schemas/ai';

/**
 * AI module contract (yol haritası #5, "Yapay zekâ A1 · Yazma yardımı"). The streamed variant of
 * `runAi` lives outside this table: AI_RAW_PATHS.stream in schemas/ai.
 *
 * Settings and usage need `org.update_settings` (owner, admin); the rest any member. Writes are
 * never callable with personal tokens (the module has no token scope).
 */
export const aiEndpoints = {
  /** Can this person use the AI buttons now, and how much of the monthly quota is left. */
  getAiStatus: def({
    method: 'GET',
    path: '/api/v1/ai/status',
    auth: 'session',
    response: AiStatus,
  }),
  /**
   * One action, the whole answer at once (mobile, tests). 429 ai_quota_exceeded,
   * 409 ai_not_configured / ai_disabled, 502 ai_provider_error.
   */
  runAi: def({
    method: 'POST',
    path: '/api/v1/ai/run',
    auth: 'session',
    body: AiRunRequest,
    response: AiRunResult,
  }),
  /**
   * The person kept the result (inserted it into the page): the audit log gets a row on the
   * run's target with `via: { kind: 'ai' }` ("AI ile"). Only the run's own author; once.
   */
  acceptAiRun: def({
    method: 'POST',
    path: '/api/v1/ai/runs/:runId/accept',
    auth: 'session',
    body: Empty,
    response: Empty,
  }),

  // ---- "Crewhall'a sor" (yol haritası #11) ----
  /**
   * Full-text (and, with an embedding model, semantic) search over pages, Drive, board cards
   * and chat messages. Only what the caller may open; vault never. Works without a model.
   */
  searchAi: def({
    method: 'GET',
    path: '/api/v1/ai/search',
    auth: 'session',
    query: AiSearchQuery,
    response: items(AiSearchHit),
  }),
  /** A question answered from the caller's content, with numbered sources ([1], [2] …). */
  askAi: def({
    method: 'POST',
    path: '/api/v1/ai/ask',
    auth: 'session',
    body: AiAskRequest,
    response: AiAskResult,
  }),

  // ---- Eylem yapan asistan (yol haritası #18) ----
  /**
   * Understands a request ("karta beni ata", "yarın 10'a toplantı kur") and puts each action it
   * can prepare into the MCP approval queue as the caller. Nothing runs before approval; the
   * approved action runs as the caller under the module's own rules. Needs the mcp module.
   */
  planAiActions: def({
    method: 'POST',
    path: '/api/v1/ai/act',
    auth: 'session',
    body: AiActRequest,
    response: AiActResult,
  }),

  // ---- Toplantı asistanı (yol haritası #12) ----
  /** The recording's transcript and notes (404 when the caller cannot open the recording). */
  getMeetingTranscript: def({
    method: 'GET',
    path: '/api/v1/ai/recordings/:recordingId/transcript',
    auth: 'session',
    response: MeetingTranscriptState,
  }),
  /** "Dökümü çıkar": transcribe and summarize now (a worker job; poll the GET). */
  startMeetingTranscript: def({
    method: 'POST',
    path: '/api/v1/ai/recordings/:recordingId/transcript',
    auth: 'session',
    body: Empty,
    response: MeetingTranscriptState,
  }),
  /** "Panoya kart aç" for action item `index` (0-based); the board's rules decide who may. */
  createMeetingActionCard: def({
    method: 'POST',
    path: '/api/v1/ai/transcripts/:transcriptId/actions/:index/card',
    auth: 'session',
    body: CreateMeetingActionCard,
    response: MeetingTranscript,
  }),
  /** Writes the meeting-notes page again when it is missing (normally written automatically). */
  createMeetingNotesPage: def({
    method: 'POST',
    path: '/api/v1/ai/transcripts/:transcriptId/page',
    auth: 'session',
    body: Empty,
    response: MeetingTranscript,
  }),

  // ---- Yönetim › Yapay zekâ ----
  getAiIndexStatus: def({
    method: 'GET',
    path: '/api/v1/ai/index',
    auth: 'session',
    response: AiIndexStatus,
  }),
  /** Re-reads every source now (normally a worker sweep every 5 minutes keeps it current). */
  rebuildAiIndex: def({
    method: 'POST',
    path: '/api/v1/ai/index/rebuild',
    auth: 'session',
    body: Empty,
    response: AiIndexStatus,
  }),
  getAiSettings: def({
    method: 'GET',
    path: '/api/v1/ai/settings',
    auth: 'session',
    response: AiSettings,
  }),
  /** Partial update; audited (the key only as "changed"). */
  updateAiSettings: def({
    method: 'PATCH',
    path: '/api/v1/ai/settings',
    auth: 'session',
    body: UpdateAiSettings,
    response: AiSettings,
  }),
  /** One tiny request to the model; the stored result shows on the settings screen. */
  testAiSettings: def({
    method: 'POST',
    path: '/api/v1/ai/settings/test',
    auth: 'session',
    body: TestAiSettings,
    response: AiTestResult,
  }),
  getAiUsage: def({
    method: 'GET',
    path: '/api/v1/ai/usage',
    auth: 'session',
    query: AiUsageQuery,
    response: AiUsageReport,
  }),
} as const satisfies Record<string, EndpointDef>;
