import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { AI_PROVIDER_INFO } from '@crewhall/shared';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';

/** Yönetim › Yapay zekâ with every provider: defaults, required fields, key handling. */

let app: TestApp;
let owner: Client;

beforeAll(async () => {
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
});

afterAll(() => app?.close());

describe('provider settings', () => {
  it('starts each hosted provider with its default model and embedding model', async () => {
    for (const provider of ['openai', 'gemini', 'mistral', 'openrouter'] as const) {
      const info = AI_PROVIDER_INFO[provider];
      const saved = await owner.api.call('updateAiSettings', {
        body: { provider, apiKey: `key-${provider}-0123456789` },
      });
      expect(saved).toMatchObject({
        provider,
        model: info.defaultModel,
        baseUrl: null,
        embeddingModel: info.defaultEmbeddingModel,
        configured: true,
        apiVersion: null,
      });
      expect(JSON.stringify(saved)).not.toContain(`key-${provider}`);
    }
  });

  it('needs a key for hosted providers and drops the old one on a provider change', async () => {
    await owner.api.call('updateAiSettings', {
      body: { provider: 'openai', apiKey: 'sk-openai-0123456789' },
    });
    const moved = await owner.api.call('updateAiSettings', { body: { provider: 'mistral' } });
    expect(moved).toMatchObject({ provider: 'mistral', configured: false, apiKey: { set: false } });
  });

  it('asks Azure for the resource address, the deployment and an api-version', async () => {
    const azure = await owner.api.call('updateAiSettings', {
      body: { provider: 'azure_openai', apiKey: 'azure-key-0123456789' },
    });
    expect(azure).toMatchObject({ configured: false, baseUrl: null, embeddingModel: null });
    const ready = await owner.api.call('updateAiSettings', {
      body: {
        baseUrl: 'https://kurum.openai.azure.com',
        model: 'gpt4o-mini-prod',
        apiVersion: '2025-01-01-preview',
      },
    });
    expect(ready).toMatchObject({
      configured: true,
      model: 'gpt4o-mini-prod',
      apiVersion: '2025-01-01-preview',
      apiKey: { set: true },
    });
    const err = await owner.api.call('updateAiSettings', { body: { baseUrl: null } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('validation_failed');
    const bad = await owner.api.call('updateAiSettings', { body: { apiVersion: 'latest' } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((bad as ApiError).status).toBe(422);
  });

  it('keeps no api-version or embeddings where the provider has none', async () => {
    const claude = await owner.api.call('updateAiSettings', {
      body: { provider: 'anthropic', apiKey: 'sk-ant-0123456789', embeddingModel: 'x' },
    });
    expect(claude).toMatchObject({ apiVersion: null, embeddingModel: null, configured: true });
  });

  it('tests a provider with unsaved values and reports a refused key', async () => {
    const result = await owner.api.call('testAiSettings', {
      body: { provider: 'gemini', apiKey: 'not-a-real-key', baseUrl: 'http://127.0.0.1:9/v1beta' },
    });
    expect(result).toMatchObject({ ok: false, error: 'connection failed' });
  });
});
