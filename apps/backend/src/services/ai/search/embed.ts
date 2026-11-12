import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@crewhall/db';
import { AI_PROVIDER_INFO, type AiProvider } from '@crewhall/shared';
import { z } from 'zod';
import { azureUrl, baseOf } from '../providers/chat';
import { geminiEmbed } from '../providers/gemini';
import { postJson, ProviderError, type ModelConfig } from '../providers/http';

/**
 * Embeddings for semantic search, from the provider the org picked when it has an embeddings
 * endpoint (AI_PROVIDER_INFO.embeddings). The Claude API has none, so with Claude the index is
 * full-text only (kararlar.md, 2026-10-22).
 */

const EmbeddingResponse = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export const EMBED_BATCH = 32;

export interface EmbedConfig {
  provider: AiProvider;
  baseUrl: string | null;
  apiKey: string | null;
  /** Azure: the embedding deployment. */
  model: string;
  apiVersion: string | null;
}

export function embedConfigOf(config: ModelConfig, embeddingModel: string | null) {
  const info = AI_PROVIDER_INFO[config.provider];
  if (!info.embeddings || !embeddingModel) return null;
  if (info.baseUrl === 'required' && !config.baseUrl) return null;
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: embeddingModel,
    apiVersion: config.apiVersion,
  } satisfies EmbedConfig;
}

/** Where an OpenAI-style embeddings request goes for this provider. */
function embedTarget(cfg: EmbedConfig): {
  url: string;
  headers: Record<string, string>;
  sendModel: boolean;
} {
  const bearer: Record<string, string> = cfg.apiKey
    ? { Authorization: `Bearer ${cfg.apiKey}` }
    : {};
  switch (cfg.provider) {
    case 'openai_compatible':
    case 'openai':
    case 'mistral':
      return { url: `${baseOf(cfg)}/embeddings`, headers: bearer, sendModel: true };
    case 'azure_openai':
      return {
        url: azureUrl(cfg, cfg.model, 'embeddings'),
        headers: cfg.apiKey ? { 'api-key': cfg.apiKey } : {},
        sendModel: false,
      };
    default:
      throw new ProviderError(`no embeddings for ${cfg.provider}`, null, 'bad_request');
  }
}

export async function embed(cfg: EmbedConfig, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (cfg.provider === 'gemini') return geminiEmbed(cfg, cfg.model, inputs);
  const target = embedTarget(cfg);
  const { res } = await postJson(target.url, {
    headers: target.headers,
    body: { ...(target.sendModel ? { model: cfg.model } : {}), input: inputs },
  });
  const parsed = EmbeddingResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success || parsed.data.data.length !== inputs.length) {
    throw new ProviderError('invalid embedding response', res.status, 'server');
  }
  return [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

let vectorMode: Promise<'pgvector' | 'array'> | null = null;

/**
 * pgvector when the extension is (or can be) installed — vectors are then compared in C — else
 * plain `real[]` arithmetic in SQL. Both read the same `real[]` column.
 */
export function vectorModeOf(db: DbOrTx): Promise<'pgvector' | 'array'> {
  vectorMode ??= (async () => {
    try {
      await db.execute(sql`create extension if not exists vector`);
    } catch {
      // No pgvector in this Postgres image or no right to install it.
    }
    const r = await db.execute(sql`select 1 from pg_extension where extname = 'vector'`);
    return r.rows.length > 0 ? 'pgvector' : 'array';
  })();
  return vectorMode;
}
