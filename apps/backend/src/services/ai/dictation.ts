import { aiRuns, newId } from '@crewhall/db';
import { AI_LIMITS, type AiTranscription } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { aiAudit } from './audit';
import { transcribe, transcriptionConfigOf } from './meeting';
import { ProviderError } from './providers';
import { providerAppError, usableSettings, type AiCaller } from './run';

/**
 * Sesle yazma for browsers without speech recognition (Firefox, the desktop app): a short
 * recording goes to the org's own speech server, the one meeting notes use, and comes back as
 * text for the question box. The audio is not stored. Each call is an ai_runs row (`dictate`), so
 * it shows in the usage report and is refused once the monthly quota is used up; it counts the
 * transcribed text as output tokens.
 */

const EXTENSION: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

export async function dictate(
  deps: Pick<Deps, 'db' | 'env' | 'logger'>,
  caller: AiCaller,
  audio: Buffer,
  contentType: string | null,
  req: RequestInfo,
): Promise<AiTranscription> {
  const settings = await usableSettings(deps, caller);
  const cfg = transcriptionConfigOf(deps, settings);
  if (!cfg) throw new AppError('ai_transcription_not_configured');
  const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = EXTENSION[mime];
  if (!ext) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['content-type'], code: 'unsupported', message: 'audio type' }],
    });
  }
  if (audio.length === 0) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: [], code: 'too_small', message: 'empty recording' }],
    });
  }
  if (audio.length > AI_LIMITS.dictationBytes) throw new AppError('file_too_large');

  const runId = newId();
  const started = performance.now();
  let out: Awaited<ReturnType<typeof transcribe>>;
  try {
    out = await transcribe(cfg, audio, `dictation.${ext}`, mime);
  } catch (err) {
    const error = err instanceof ProviderError ? err.message : 'unknown error';
    if (!(err instanceof ProviderError)) deps.logger.error({ err }, 'dictation failed');
    await record(
      deps,
      caller,
      { runId, model: cfg.model, settings, started, text: '', error },
      req,
    );
    throw providerAppError(err);
  }
  const text = out.text.trim();
  await record(
    deps,
    caller,
    { runId, model: cfg.model, settings, started, text, error: null },
    req,
  );
  return { text, language: out.language ?? null };
}

async function record(
  deps: Pick<Deps, 'db'>,
  caller: AiCaller,
  run: {
    runId: string;
    model: string;
    settings: Awaited<ReturnType<typeof usableSettings>>;
    started: number;
    text: string;
    error: string | null;
  },
  req: RequestInfo,
) {
  const outputTokens = Math.ceil(run.text.length / 4);
  await deps.db.insert(aiRuns).values({
    id: run.runId,
    orgId: caller.org.id,
    userId: caller.userId,
    action: 'dictate',
    provider: run.settings.provider,
    model: run.model,
    targetType: 'draft',
    targetId: null,
    status: run.error ? 'error' : 'ok',
    error: run.error,
    inputTokens: 0,
    outputTokens,
    latencyMs: Math.round(performance.now() - run.started),
  });
  await aiAudit(
    deps.db,
    {
      orgId: caller.org.id,
      actorId: caller.userId,
      action: 'ai.run',
      targetType: 'draft',
      targetId: null,
      meta: { action: 'dictate', status: run.error ? 'error' : 'ok', outputTokens },
      via: { kind: 'ai', provider: 'transcription', model: run.model, runId: run.runId },
    },
    req,
  );
}
