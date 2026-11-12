import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import { endpoints, type EndpointName } from '@crewhall/shared';
import { buildOpenApi, type OpenApiDocument } from '../src/services/openapi';
import { tokenScopeOf } from '../src/services/mcp/rest';
import { createTestApp, type TestApp } from './helpers';

/** The open API document (roadmap 4): valid OpenAPI 3.1 that covers the whole contract. */

const names = Object.keys(endpoints) as EndpointName[];
const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function refsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => refsOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') out.add(v);
      else refsOf(v, out);
    }
  }
  return out;
}

describe('OpenAPI document', () => {
  const doc: OpenApiDocument = buildOpenApi({ serverUrl: 'https://hub.example.com', locale: 'tr' });

  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(structuredClone(doc));
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(doc.openapi).toMatch(/^3\.1\./);
  });

  it('documents every endpoint of the contract, a new one included', () => {
    for (const name of names) {
      const e = endpoints[name];
      const op = (doc.paths[openApiPath(e.path)] as Record<string, { operationId?: string }>)?.[
        e.method.toLowerCase()
      ];
      expect(op?.operationId, name).toBe(name);
    }
    const operations = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(operations).toHaveLength(names.length);
  });

  it('resolves every schema reference inside the document', () => {
    for (const ref of refsOf(doc)) {
      expect(ref, ref).toMatch(/^#\/components\/schemas\//);
      expect(doc.components.schemas[ref.split('/').pop()!], ref).toBeDefined();
    }
  });

  it('says which personal token scope an endpoint needs, never for the vault or the account', () => {
    for (const name of names) {
      const e = endpoints[name];
      const op = (doc.paths[openApiPath(e.path)] as Record<string, Record<string, unknown>>)[
        e.method.toLowerCase()
      ]!;
      const scope = e.auth === 'public' ? null : tokenScopeOf(name);
      expect(op['x-crewhall-token-scope'], name).toBe(scope);
      const security = op.security as Record<string, string[]>[];
      expect(
        security.some((s) => 'personalToken' in s),
        name,
      ).toBe(scope !== null);
    }
    const get = (name: EndpointName) =>
      (doc.paths[openApiPath(endpoints[name].path)] as Record<string, Record<string, unknown>>)[
        endpoints[name].method.toLowerCase()
      ]!;
    expect(get('listSpaces')['x-crewhall-token-scope']).toBe('hub:read');
    expect(get('vaultKeys')['x-crewhall-token-scope']).toBeNull();
    expect(get('updateMe')['x-crewhall-token-scope']).toBeNull();
  });

  it('describes requests by their input side and responses by their output side', () => {
    const create = doc.paths['/api/v1/spaces/{spaceId}/folders'] as Record<string, unknown>;
    const body = JSON.stringify(create.post);
    expect(body).toContain('"name":"spaceId","in":"path"');
    expect(body).toContain('"name":"Idempotency-Key","in":"header"');
    const list = JSON.stringify(doc.paths['/api/v1/spaces/{spaceId}/nodes']);
    expect(list).toContain('"in":"query"');
    expect(doc.components.schemas.ApiErrorBody).toMatchObject({
      properties: { code: { enum: expect.arrayContaining(['not_found', 'token_scope']) } },
    });
  });
});

describe('GET /api/openapi.json and /api/docs', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('serves the document without a session, in the asked language', async () => {
    const tr = await app.app.request('/api/openapi.json');
    expect(tr.status).toBe(200);
    expect(tr.headers.get('content-type')).toContain('application/json');
    const trDoc = (await tr.json()) as OpenApiDocument;
    expect(trDoc.servers[0]!.url).toBe('http://localhost:3000');
    expect(trDoc.info.description).toContain('kişisel token');
    const en = (await (await app.app.request('/api/openapi.json?lang=en')).json()) as {
      info: { description: string };
    };
    expect(en.info.description).toContain('personal token');
  });

  it('sends /api/docs to the reference screen', async () => {
    const res = await app.app.request('/api/docs');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/account\/mcp\/api$/);
  });
});
