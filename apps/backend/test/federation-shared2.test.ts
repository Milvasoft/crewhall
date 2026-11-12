import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { nodes, organizations, runMigrations } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { MEET_IDENTITY, MEET_RAW_PATHS } from '@crewhall/shared';
import { blobContent } from '../src/services/federation/files';
import { scanSharedFolders } from '../src/services/federation/folders';
import { liveKitSigning, setLiveKit, type LiveKitGateway } from '../src/services/meet/livekit';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/**
 * Shared channels 2 (kararlar.md): a shared folder kept in step on three installations (A
 * hosts, B and C are guests) and the host's channel meeting joined from a guest copy.
 */

interface Instance {
  app: TestApp;
  domain: string;
  owner: Client;
  ownerId: string;
  spaceId: string;
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function freshDatabase(name: string): Promise<string> {
  const base = inject('databaseUrl');
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  return url.toString();
}

async function instance(db: string, env: Record<string, string> = {}): Promise<Instance> {
  const port = await freePort();
  const app = await createTestApp({
    API_URL: `http://127.0.0.1:${port}`,
    FEDERATION_ALLOW_HTTP: 'true',
    DATABASE_URL: await freshDatabase(db),
    ...env,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    ) as Server;
  });
  app.realtime.attach(server);
  const { owner, ownerId } = await setupWithOwner(app);
  const spaceId = (await owner.api.call('listSpaces')).items.find(
    (s) => s.name === 'Milvasoft',
  )!.id;
  return {
    app,
    domain: `127.0.0.1:${port}`,
    owner,
    ownerId,
    spaceId,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await app.close();
    },
  };
}

async function expectCode(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    if (code) expect((err as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${status}`);
}

async function befriend(x: Instance, y: Instance) {
  await x.owner.api.call('addFederationPeer', { body: { domain: y.domain } });
  await y.owner.api.call('addFederationPeer', { body: { domain: x.domain } });
}

/** A copy of the shared folder as "path:size" lines (folders end with "/"). */
async function tree(i: Instance, rootId: string) {
  const db = i.app.deps.db;
  const [root] = await db.select().from(nodes).where(eq(nodes.id, rootId));
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        sql`${nodes.path} <@ ${root!.path}::ltree`,
        ne(nodes.id, rootId),
        isNull(nodes.deletedAt),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const name = (r: (typeof rows)[number]): string =>
    r.parentId === rootId ? r.name : `${name(byId.get(r.parentId!)!)}/${r.name}`;
  return rows.map((r) => (r.type === 'file' ? `${name(r)}:${r.sizeBytes}` : `${name(r)}/`)).sort();
}

async function text(i: Instance, nodeId: string) {
  const [org] = await i.app.deps.db.select().from(organizations).limit(1);
  return (await blobContent(i.app.deps, org!, nodeId)).content.toString();
}

/** Node id of `path` (slash separated) under a copy. */
async function nodeAt(i: Instance, rootId: string, path: string) {
  let parent = rootId;
  for (const part of path.split('/')) {
    const [row] = await i.app.deps.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.parentId, parent), eq(nodes.name, part), isNull(nodes.deletedAt)));
    if (!row) throw new Error(`no ${path}`);
    parent = row.id;
  }
  return parent;
}

const scanAll = async () => {
  for (const i of [a, b, c]) await scanSharedFolders(i.app.deps);
};

// ---- LiveKit stand-in (tokens and webhook checks are the real SDK) ----

const KEY = 'test-key';
const SECRET = 'test-secret-0123456789abcdef0123456789';

function fakeLiveKit(): LiveKitGateway {
  const noop = async () => undefined;
  return {
    publicUrl: 'ws://livekit.host.test',
    egressEnabled: false,
    ...liveKitSigning({ apiKey: KEY, apiSecret: SECRET }),
    ensureRoom: noop,
    updateRoomMetadata: noop,
    deleteRoom: noop,
    sendSignal: noop,
    listParticipants: async () => [],
    listRooms: async () => [],
    muteTrack: noop,
    updateParticipant: noop,
    removeParticipant: noop,
    startRecording: async () => ({ egressId: 'EG_1' }),
    stopRecording: noop,
  };
}

let seq = 0;
async function webhook(i: Instance, body: Record<string, unknown>) {
  const raw = JSON.stringify({
    id: `EV_${++seq}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    ...body,
  });
  const at = new AccessToken(KEY, SECRET);
  at.sha256 = createHash('sha256').update(raw).digest('base64');
  const res = await i.app.app.request(`http://localhost:3000${MEET_RAW_PATHS.livekitWebhook}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: await at.toJwt() },
    body: raw,
  });
  expect(res.status).toBeLessThan(300);
}

let a: Instance;
let b: Instance;
let c: Instance;
let elif: Client;
let can: Client;
let deniz: Client;
let channelA: string;
let channelB: string;
let channelC: string;

beforeAll(async () => {
  a = await instance('crewhall_fed_shared2_a');
  b = await instance('crewhall_fed_shared2_b');
  c = await instance('crewhall_fed_shared2_c', { FEDERATION_AUTO_ACCEPT_DOMAINS: a.domain });
  setLiveKit(a.app.deps, fakeLiveKit());
  elif = (await join(a.app, a.owner, 'elif@milvasoft.com', 'member', [a.spaceId])).person;
  // Guests' people edit the shared folder's copy: editors of the channel's space.
  const editor = async (i: Instance, email: string) => {
    const j = await join(i.app, i.owner, email, 'member', [i.spaceId]);
    await i.owner.api.call('updateSpaceMember', {
      params: { spaceId: i.spaceId, userId: j.me.user.id },
      body: { role: 'editor' },
    });
    return j.person;
  };
  can = await editor(b, 'can@acme.com');
  deniz = await editor(c, 'deniz@globex.com');
  for (const i of [a, b, c]) {
    await i.owner.api.call('updateFederation', {
      body: { enabled: true, sharedChannels: { enabled: true } },
    });
  }
  await befriend(a, b);
  await befriend(a, c);
  channelA = (
    await a.owner.api.call('createConversation', {
      body: { type: 'space', spaceId: a.spaceId, name: 'Ortak proje' },
    })
  ).id;
  await a.owner.api.call('shareChannel', {
    params: { conversationId: channelA },
    body: { domain: b.domain },
  });
  const invite = (await b.owner.api.call('listSharedChannels')).items[0]!;
  channelB = (
    await b.owner.api.call('acceptSharedChannel', {
      params: { shareId: invite.id },
      body: { spaceId: b.spaceId },
    })
  ).conversationId!;
  await a.owner.api.call('shareChannel', {
    params: { conversationId: channelA },
    body: { domain: c.domain },
  });
  channelC = (await c.owner.api.call('listSharedChannels')).items[0]!.conversationId!;
}, 240_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await c?.close();
});

describe('shared folder', () => {
  let rootA: string;
  let rootB: string;
  let rootC: string;

  it('copies the folder and its contents to every organization', async () => {
    const folder = await a.owner.api.call('createFolder', {
      params: { spaceId: a.spaceId },
      body: { name: 'Ortak dosyalar' },
    });
    rootA = folder.id;
    await uploadFile(a.owner, {
      spaceId: a.spaceId,
      parentId: rootA,
      name: 'plan.txt',
      content: Buffer.from('ilk plan'),
      mime: 'text/plain',
    });
    const drafts = await a.owner.api.call('createFolder', {
      params: { spaceId: a.spaceId },
      body: { parentId: rootA, name: 'Taslaklar' },
    });
    await uploadFile(a.owner, {
      spaceId: a.spaceId,
      parentId: drafts.id,
      name: 'not.md',
      content: Buffer.from('# not'),
      mime: 'text/markdown',
    });
    // Only the host shares, and only folders of the channel's space.
    await expectCode(
      elif.api.call('shareFolder', {
        params: { conversationId: channelA },
        body: { nodeId: rootA },
      }),
      403,
    );
    const shared = await a.owner.api.call('shareFolder', {
      params: { conversationId: channelA },
      body: { nodeId: rootA },
    });
    expect(shared).toMatchObject({ role: 'host', status: 'active', name: 'Ortak dosyalar' });

    const onB = (await can.api.call('listSharedFolders', { params: { conversationId: channelB } }))
      .items[0]!;
    expect(onB).toMatchObject({ role: 'guest', status: 'active', homeDomain: a.domain });
    rootB = onB.nodeId!;
    rootC = (await deniz.api.call('listSharedFolders', { params: { conversationId: channelC } }))
      .items[0]!.nodeId!;
    const expected = ['Taslaklar/', 'Taslaklar/not.md:5', 'plan.txt:8'];
    expect(await tree(b, rootB)).toEqual(expected);
    expect(await tree(c, rootC)).toEqual(expected);
    expect(await text(b, await nodeAt(b, rootB, 'plan.txt'))).toBe('ilk plan');
    // Nothing echoes back from the copies.
    await scanAll();
    expect(await tree(a, rootA)).toEqual(expected);
  });

  it('carries a guest’s new file to the host and on to the other guest', async () => {
    await uploadFile(can, {
      spaceId: b.spaceId,
      parentId: rootB,
      name: 'teklif.txt',
      content: Buffer.from('acme teklifi'),
      mime: 'text/plain',
    });
    await scanAll();
    for (const [i, root] of [
      [a, rootA],
      [c, rootC],
    ] as const) {
      expect(await tree(i, root)).toContain('teklif.txt:12');
      expect(await text(i, await nodeAt(i, root, 'teklif.txt'))).toBe('acme teklifi');
    }
  });

  it('carries renames, new versions and deletes', async () => {
    await a.owner.api.call('updateNode', {
      params: { nodeId: await nodeAt(a, rootA, 'Taslaklar') },
      body: { name: 'Taslaklar 2026' },
    });
    await uploadFile(deniz, {
      spaceId: c.spaceId,
      parentId: rootC,
      name: 'plan.txt',
      nodeId: await nodeAt(c, rootC, 'plan.txt'),
      content: Buffer.from('ikinci plan'),
      mime: 'text/plain',
    });
    await can.api.call('trashNodes', {
      body: { nodeIds: [await nodeAt(b, rootB, 'teklif.txt')] },
    });
    await scanAll();
    // A second round relays what the host applied in the first.
    await scanAll();
    const expected = ['Taslaklar 2026/', 'Taslaklar 2026/not.md:5', 'plan.txt:11'];
    expect(await tree(a, rootA)).toEqual(expected);
    expect(await tree(b, rootB)).toEqual(expected);
    expect(await tree(c, rootC)).toEqual(expected);
    expect(await text(b, await nodeAt(b, rootB, 'plan.txt'))).toBe('ikinci plan');
  });

  it('stops when the host ends it; the copies stay', async () => {
    const folder = (
      await a.owner.api.call('listSharedFolders', { params: { conversationId: channelA } })
    ).items[0]!;
    const ended = await a.owner.api.call('endSharedFolder', {
      params: { conversationId: channelA, folderId: folder.id },
    });
    expect(ended.status).toBe('ended');
    const onB = (await can.api.call('listSharedFolders', { params: { conversationId: channelB } }))
      .items[0]!;
    expect(onB.status).toBe('ended');
    await uploadFile(a.owner, {
      spaceId: a.spaceId,
      parentId: rootA,
      name: 'sonra.txt',
      content: Buffer.from('x'),
    });
    await scanAll();
    expect(await tree(b, rootB)).not.toContain('sonra.txt:1');
    expect(await tree(b, rootB)).toContain('plan.txt:11');
  });
});

describe('shared meeting', () => {
  let room: string;

  it('shows the host’s channel meeting in the guest copies while it goes on', async () => {
    const m = await a.owner.api.call('createMeeting', {
      body: { mode: 'instant', conversationId: channelA },
    });
    room = `m-${m.id}`;
    expect(
      (await can.api.call('getConversation', { params: { conversationId: channelB } })).federation
        ?.meeting ?? null,
    ).toBeNull();
    await webhook(a, {
      event: 'participant_joined',
      room: { sid: `RM_${room}`, name: room },
      participant: {
        sid: 'PA_1',
        identity: MEET_IDENTITY.user(a.ownerId),
        name: 'Ahmet',
        metadata: JSON.stringify({ userId: a.ownerId, role: 'moderator', guest: false }),
        joinedAt: String(Math.floor(Date.now() / 1000)),
      },
    });
    const conv = await can.api.call('getConversation', { params: { conversationId: channelB } });
    expect(conv.federation?.meeting).toMatchObject({ title: 'Ortak proje', domain: a.domain });
  });

  it('lets a guest organization’s member join as a guest on the host', async () => {
    const joined = await can.api.call('joinSharedMeeting', {
      params: { conversationId: channelB },
    });
    expect(joined.domain).toBe(a.domain);
    expect(joined.connection.url).toBe('ws://livekit.host.test');
    expect(joined.connection.role).toBe('guest');
    const claims = await new TokenVerifier(KEY, SECRET).verify(joined.connection.token);
    expect(claims.video?.room).toBe(room);
    // Their name and organization, as the host shows guests.
    expect(claims.name).toBe('can · Milvasoft');
  });

  it('refuses someone the host blocked', async () => {
    // The host knows can once they wrote in the channel.
    await can.api.call('sendMessage', {
      params: { conversationId: channelB },
      body: { clientMsgId: crypto.randomUUID(), text: 'merhaba' },
    });
    await a.owner.api.call('blockRemoteMember', {
      params: { conversationId: channelA },
      body: { address: `can@${b.domain}`, blocked: true },
    });
    await expectCode(
      can.api.call('joinSharedMeeting', { params: { conversationId: channelB } }),
      403,
      'federation_not_allowed',
    );
    await a.owner.api.call('blockRemoteMember', {
      params: { conversationId: channelA },
      body: { address: `can@${b.domain}`, blocked: false },
    });
  });

  it('clears the banner when the meeting ends', async () => {
    await webhook(a, { event: 'room_finished', room: { sid: `RM_${room}`, name: room } });
    const conv = await deniz.api.call('getConversation', { params: { conversationId: channelC } });
    expect(conv.federation?.meeting ?? null).toBeNull();
  });
});
