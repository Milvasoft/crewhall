import { describe, expect, it, vi } from 'vitest';
import { ApiError, buildPath, createApiClient } from './index';

describe('buildPath', () => {
  it('fills and encodes params', () => {
    expect(
      buildPath('/api/v1/spaces/:spaceId/members/:userId', { spaceId: 'a b', userId: 'u' }),
    ).toBe('/api/v1/spaces/a%20b/members/u');
  });
  it('throws on missing params', () => {
    expect(() => buildPath('/api/v1/spaces/:spaceId', {})).toThrow();
  });
});

describe('createApiClient', () => {
  it('sends bearer token, body and query; maps error bodies to ApiError', async () => {
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/api/v1/spaces' && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 'space_slug_taken', message: 'taken' }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    });
    const api = createApiClient({
      baseUrl: 'https://hub.example.test',
      getToken: () => 't0k',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await api.call('listMembers', { query: { limit: 10, q: 'ali' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.toString()).toBe('https://hub.example.test/api/v1/org/members?limit=10&q=ali');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer t0k');

    await expect(
      api.call('createSpace', { body: { name: 'X', color: 's1' } }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'space_slug_taken',
    } satisfies Partial<ApiError>);
  });
});
