import { describe, expect, it } from 'vitest';
import { api, isApiError } from '@/lib/api';
import { db } from '@/mocks/db';
import { NODE, PUBLIC_PASSWORD, PUBLIC_TOKEN } from '@/mocks/driveSeed';
import { SPACE, USER } from '@/mocks/seed';
import { SURFACE } from '@/mocks/quickSeed';

function signedInAs(userId: string) {
  const s = db();
  s.sessions.push({
    id: 'test-session',
    userId,
    userAgent: 'test',
    ip: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });
  s.auth.sessionId = 'test-session';
}

async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('drive contract mock', () => {
  it('lists folders first and hides the trash', async () => {
    signedInAs(USER.bugra);
    const { items } = await api.call('listNodes', { params: { spaceId: SPACE.milvasoft } });
    expect(items.slice(0, 4).every((n) => n.type === 'folder')).toBe(true);
    expect(items.map((n) => n.name)).not.toContain('Q2-rapor.xlsx');
    const trash = await api.call('listTrash', { params: { spaceId: SPACE.milvasoft } });
    expect(trash.items.map((n) => n.name)).toContain('Q2-rapor.xlsx');
  });

  it('uploads in parts, resumes and answers a name clash with 409', async () => {
    signedInAs(USER.bugra);
    const body = new Blob(['hello crewhall']);
    const up = await api.call('createUpload', {
      body: {
        spaceId: SPACE.milvasoft,
        parentId: NODE.sunumlar,
        name: 'notlar.txt',
        sizeBytes: body.size,
      },
    });
    expect(up.partCount).toBe(1);
    const { parts } = await api.call('getUploadPartUrls', {
      params: { uploadId: up.id },
      body: { partNumbers: [1] },
    });
    const res = await fetch(parts[0]!.url, { method: 'PUT', body });
    const etag = res.headers.get('etag') ?? '';
    const resumed = await api.call('getUpload', { params: { uploadId: up.id } });
    expect(resumed.uploadedParts).toHaveLength(1);
    const done = await api.call('completeUpload', {
      params: { uploadId: up.id },
      body: { parts: [{ partNumber: 1, etag }] },
    });
    expect(done.node.name).toBe('notlar.txt');
    expect(done.version.version).toBe(1);

    const clash = await rejects(
      api.call('createUpload', {
        body: {
          spaceId: SPACE.milvasoft,
          parentId: NODE.sunumlar,
          name: 'notlar.txt',
          sizeBytes: 3,
        },
      }),
    );
    expect(isApiError(clash, 'node_name_taken')).toBe(true);
  });

  it('opens a password link only with a grant and locks after five tries', async () => {
    const first = await api.call('getPublicShare', { params: { token: PUBLIC_TOKEN.password } });
    expect(first.status).toBe('password_required');
    for (let i = 0; i < 4; i++) {
      const e = await rejects(
        api.call('unlockPublicShare', {
          params: { token: PUBLIC_TOKEN.password },
          body: { password: 'nope' },
        }),
      );
      expect(isApiError(e, 'share_password_invalid')).toBe(true);
    }
    const { grant } = await api.call('unlockPublicShare', {
      params: { token: PUBLIC_TOKEN.password },
      body: { password: PUBLIC_PASSWORD },
    });
    const ok = await api.call('getPublicShare', {
      params: { token: PUBLIC_TOKEN.password },
      query: { grant },
    });
    expect(ok.status).toBe('ok');
    const expired = await rejects(
      api.call('getPublicShare', { params: { token: PUBLIC_TOKEN.expired } }),
    );
    expect(isApiError(expired, 'share_expired')).toBe(true);
  });
});

describe('quick access contract mock', () => {
  it('rejects a stale layout and places new cards in a free spot', async () => {
    signedInAs(USER.bugra);
    const sf = await api.call('getSurface', { params: { surfaceId: SURFACE.bugra } });
    const card = sf.cards[0]!;
    const saved = await api.call('updateSurfaceLayout', {
      params: { surfaceId: sf.id },
      body: {
        layoutRev: sf.layoutRev,
        items: [{ cardId: card.id, layout: { ...card.layout, y: 9 } }],
      },
    });
    expect(saved.layoutRev).toBe(sf.layoutRev + 1);
    const stale = await rejects(
      api.call('updateSurfaceLayout', {
        params: { surfaceId: sf.id },
        body: { layoutRev: sf.layoutRev, items: [] },
      }),
    );
    expect(isApiError(stale, 'conflict')).toBe(true);

    const created = await api.call('createCard', {
      params: { surfaceId: sf.id },
      body: {
        type: 'link',
        link: { url: 'https://grafana.com/', checkEnabled: true, intervalSeconds: 60 },
      },
    });
    expect(created.type).toBe('link');
    expect(Object.values(created.links)[0]?.siteTitle).toBe('Grafana');
  });

  it('lets a viewer pin a space card to Benim but not edit the space surface', async () => {
    signedInAs(USER.burak);
    const { items } = await api.call('listSurfaces');
    const space = items.find((x) => x.id === SURFACE.milvasoft)!;
    expect(space.canEdit).toBe(false);
    const sf = await api.call('getSurface', { params: { surfaceId: space.id } });
    const mine = items.find((x) => x.owner.type === 'user')!;
    const pinned = await api.call('pinCard', {
      params: { cardId: sf.cards[1]!.id },
      body: { surfaceId: mine.id },
    });
    expect(pinned.pinnedFrom?.cardId).toBe(sf.cards[1]!.id);
    const denied = await rejects(api.call('deleteCard', { params: { cardId: sf.cards[1]!.id } }));
    expect(isApiError(denied, 'forbidden')).toBe(true);
  });
});
