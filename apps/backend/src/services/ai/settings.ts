import { eq } from 'drizzle-orm';
import { aiSettings, type DbOrTx } from '@crewhall/db';
import {
  AI_DEFAULT_MODEL,
  AI_PROVIDER_INFO,
  AZURE_DEFAULT_API_VERSION,
  type AiProvider,
  AiTestResult,
  type AiSettings,
  type TestAiSettings,
  type UpdateAiSettings,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { aiAudit } from './audit';
import { decryptApiKey, encryptApiKey, keyHint } from './crypto';
import { TEST_PROMPT } from './prompts';
import { modelClient, ProviderError, type ModelConfig } from './providers';
import { clearEmbeddings } from './search/indexer';

export type SettingsRow = typeof aiSettings.$inferSelect;

export async function loadSettings(db: DbOrTx, orgId: string): Promise<SettingsRow | null> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.orgId, orgId));
  return row ?? null;
}

/** Complete for its provider: a key where one is required, an address where there is no default. */
export function isConfigured(
  row: Pick<SettingsRow, 'provider' | 'apiKeyEnc' | 'baseUrl' | 'model'> | null,
) {
  if (!row || !row.model) return false;
  const info = AI_PROVIDER_INFO[row.provider];
  if (info.apiKey === 'required' && row.apiKeyEnc === null) return false;
  if (info.baseUrl === 'required' && row.baseUrl === null) return false;
  return true;
}

export function toSettingsView(row: SettingsRow | null): AiSettings {
  const lastTest = row?.lastTest ? AiTestResult.safeParse(row.lastTest) : null;
  return {
    enabled: row?.enabled ?? false,
    provider: row?.provider ?? 'anthropic',
    model: row?.model ?? AI_DEFAULT_MODEL,
    baseUrl: row?.baseUrl ?? null,
    apiVersion: row?.apiVersion ?? null,
    apiKey: {
      set: !!row?.apiKeyEnc,
      hint: row?.apiKeyEnc ? (row.apiKeyHint ?? null) : null,
      updatedAt: row?.apiKeyEnc ? (row.apiKeyUpdatedAt?.toISOString() ?? null) : null,
    },
    configured: isConfigured(row),
    orgMonthlyTokens: row?.orgMonthlyTokens ?? null,
    userMonthlyTokens: row?.userMonthlyTokens ?? null,
    embeddingModel: row?.embeddingModel ?? null,
    fastModel: row?.fastModel ?? null,
    transcriptionUrl: row?.transcriptionUrl ?? null,
    transcriptionModel: row?.transcriptionModel ?? null,
    meetingNotes: row?.meetingNotes ?? false,
    lastTest: lastTest?.success ? lastTest.data : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/**
 * The stored settings as a model connection; the key decrypted in memory only. `fast` picks the
 * admin's "Hızlı model" (same provider and key) for short structured steps, when there is one.
 */
export function modelConfigOf(
  deps: Pick<Deps, 'env'>,
  row: SettingsRow,
  opts: { fast?: boolean } = {},
): ModelConfig {
  const apiKey = row.apiKeyEnc
    ? decryptApiKey(deps.env.AUTH_SECRET, row.orgId, row.apiKeyEnc)
    : null;
  if (row.apiKeyEnc && apiKey === null) {
    // AUTH_SECRET changed since the key was saved: the admin has to enter it again.
    throw new AppError('ai_not_configured', { reason: 'key_unreadable' });
  }
  return {
    provider: row.provider,
    model: (opts.fast && row.fastModel) || row.model,
    baseUrl: row.baseUrl,
    apiKey,
    apiVersion: apiVersionOf(row.provider, row.apiVersion),
  };
}

const apiVersionOf = (provider: AiProvider, stored: string | null) =>
  AI_PROVIDER_INFO[provider].apiVersion ? (stored ?? AZURE_DEFAULT_API_VERSION) : null;

/**
 * Partial update. Changing the provider or the base URL drops the stored key unless a new one
 * comes with it, so a key can never be sent to a server it was not entered for.
 */
export async function updateSettings(
  deps: Deps,
  who: { orgId: string; userId: string },
  body: UpdateAiSettings,
  req: RequestInfo,
): Promise<AiSettings> {
  const before = await loadSettings(deps.db, who.orgId);
  const provider = body.provider ?? before?.provider ?? 'anthropic';
  const info = AI_PROVIDER_INFO[provider];
  const providerChanged = before !== null && provider !== before.provider;
  // A new provider starts from its own address (hosted) or an empty one (own server, Azure).
  const baseUrl =
    body.baseUrl !== undefined ? body.baseUrl : providerChanged ? null : (before?.baseUrl ?? null);
  const baseUrlChanged = before !== null && baseUrl !== before.baseUrl;
  // The key may go only to the server it was entered for. Entering the first address of a
  // provider that has no default one (Azure, own server) is not a move: the key went nowhere yet.
  const endpointMoved =
    providerChanged ||
    (baseUrlChanged && !(info.baseUrl === 'required' && before?.baseUrl === null));
  if (info.baseUrl === 'required' && body.baseUrl === null) {
    throw new AppError('validation_failed', { in: 'body', field: 'baseUrl' });
  }

  let key: Pick<SettingsRow, 'apiKeyEnc' | 'apiKeyHint' | 'apiKeyUpdatedAt'> | null = null;
  if (typeof body.apiKey === 'string') {
    key = {
      apiKeyEnc: encryptApiKey(deps.env.AUTH_SECRET, who.orgId, body.apiKey),
      apiKeyHint: keyHint(body.apiKey),
      apiKeyUpdatedAt: new Date(),
    };
  } else if (body.apiKey === null || (endpointMoved && before?.apiKeyEnc)) {
    key = { apiKeyEnc: null, apiKeyHint: null, apiKeyUpdatedAt: new Date() };
  }

  const model =
    body.model ?? (providerChanged ? info.defaultModel : before?.model) ?? info.defaultModel;
  const apiVersion = info.apiVersion
    ? body.apiVersion !== undefined
      ? body.apiVersion
      : providerChanged
        ? null
        : (before?.apiVersion ?? null)
    : null;
  const connectionChanged =
    !before ||
    providerChanged ||
    baseUrlChanged ||
    model !== before.model ||
    apiVersion !== before.apiVersion ||
    (key !== null && key.apiKeyEnc !== before.apiKeyEnc);

  const values = {
    enabled: body.enabled ?? before?.enabled ?? false,
    provider,
    model,
    baseUrl,
    apiVersion,
    ...(key ?? {}),
    orgMonthlyTokens:
      body.orgMonthlyTokens !== undefined
        ? body.orgMonthlyTokens
        : (before?.orgMonthlyTokens ?? null),
    userMonthlyTokens:
      body.userMonthlyTokens !== undefined
        ? body.userMonthlyTokens
        : (before?.userMonthlyTokens ?? null),
    // Only providers with an embeddings endpoint; a new provider starts with its default.
    embeddingModel: !info.embeddings
      ? null
      : body.embeddingModel !== undefined
        ? body.embeddingModel
        : providerChanged || !before
          ? info.defaultEmbeddingModel
          : (before?.embeddingModel ?? null),
    // Another provider's model names mean nothing here: a provider change clears it.
    fastModel:
      body.fastModel !== undefined
        ? body.fastModel
        : providerChanged
          ? null
          : (before?.fastModel ?? null),
    transcriptionUrl:
      body.transcriptionUrl !== undefined
        ? body.transcriptionUrl
        : (before?.transcriptionUrl ?? null),
    transcriptionModel:
      body.transcriptionModel !== undefined
        ? body.transcriptionModel
        : (before?.transcriptionModel ?? null),
    meetingNotes: body.meetingNotes ?? before?.meetingNotes ?? false,
    ...(connectionChanged ? { lastTest: null } : {}),
    updatedBy: who.userId,
    updatedAt: new Date(),
  };
  const [row] = await deps.db
    .insert(aiSettings)
    .values({ orgId: who.orgId, ...values })
    .onConflictDoUpdate({ target: aiSettings.orgId, set: values })
    .returning();

  // Vectors from another model or server cannot be compared with new ones.
  if (
    before &&
    (before.embeddingModel !== row!.embeddingModel || providerChanged || baseUrlChanged)
  ) {
    await clearEmbeddings(deps.db, who.orgId);
  }

  const changed = (Object.keys(body) as (keyof UpdateAiSettings)[]).filter((k) => k !== 'apiKey');
  await aiAudit(
    deps.db,
    {
      orgId: who.orgId,
      actorId: who.userId,
      action: 'ai.settings.update',
      targetType: 'org',
      targetId: who.orgId,
      meta: {
        changed,
        enabled: row!.enabled,
        provider: row!.provider,
        model: row!.model,
        key: key === null ? 'kept' : key.apiKeyEnc ? 'set' : 'removed',
      },
    },
    req,
  );
  return toSettingsView(row!);
}

/**
 * One tiny request with the stored settings, or with the values from the form (fields left out
 * fall back to the stored ones; the stored key only while provider and URL are unchanged).
 */
export async function testSettings(
  deps: Deps,
  orgId: string,
  body: TestAiSettings,
): Promise<AiTestResult> {
  const stored = await loadSettings(deps.db, orgId);
  const provider = body.provider ?? stored?.provider ?? 'anthropic';
  const info = AI_PROVIDER_INFO[provider];
  const baseUrl =
    body.baseUrl !== undefined
      ? body.baseUrl
      : provider === stored?.provider
        ? stored.baseUrl
        : null;
  const sameEndpoint =
    stored !== null && provider === stored.provider && baseUrl === stored.baseUrl;
  const apiKey =
    body.apiKey ?? (sameEndpoint && stored ? modelConfigOf(deps, stored).apiKey : null);
  const config: ModelConfig = {
    provider,
    model: body.model ?? (provider === stored?.provider ? stored.model : info.defaultModel),
    baseUrl,
    apiKey,
    apiVersion: apiVersionOf(
      provider,
      body.apiVersion !== undefined
        ? body.apiVersion
        : provider === stored?.provider
          ? stored.apiVersion
          : null,
    ),
  };
  const overrides = Object.keys(body).length > 0;

  const started = performance.now();
  let result: AiTestResult;
  try {
    const client = modelClient(config);
    let gotText = false;
    for await (const chunk of client.stream({ ...TEST_PROMPT, maxTokens: 256 })) {
      if (chunk.type === 'text' && chunk.text.trim()) gotText = true;
    }
    result = {
      ok: true,
      at: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      error: gotText ? null : 'empty answer',
    };
  } catch (err) {
    result = {
      ok: false,
      at: new Date().toISOString(),
      latencyMs: null,
      error: err instanceof ProviderError ? err.message : 'unknown error',
    };
    if (!(err instanceof ProviderError)) deps.logger.warn({ err }, 'ai test failed');
  }
  if (stored && !overrides) {
    await deps.db.update(aiSettings).set({ lastTest: result }).where(eq(aiSettings.orgId, orgId));
  }
  return result;
}
