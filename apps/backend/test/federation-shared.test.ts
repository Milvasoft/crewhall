import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { federationKeys, federationPeers, runMigrations } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { demoKeyPair } from '../src/services/federation/keys';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/**
 * Shared channels (kararlar.md 2026-10-29): channels shared between whole organizations on
 * three installations (A hosts, B accepts by hand, C accepts automatically), each with its
 * own database and HTTP server.
 */

interface Instance {
  app: TestApp;
  domain: string;
  owner: Client;
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
  const { owner } = await setupWithOwner(app);
  const spaceId = (await owner.api.call('listSpaces')).items.find(
    (s) => s.name === 'Milvasoft',
  )!.id;
  return {
    app,
    domain: `127.0.0.1:${port}`,
    owner,
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

const list = async (c: Client, conversationId: string) =>
  (await c.api.call('listMessages', { params: { conversationId }, query: {} })).items.filter(
    (m) => m.kind === 'user',
  );

const texts = async (c: Client, conversationId: string) =>
  (await list(c, conversationId))
    .filter((m) => !m.deletedAt)
    .map((m) => ({ text: m.text, from: m.remoteAuthor?.address ?? m.author?.email ?? null }));

const send = (c: Client, conversationId: string, text: string, attachmentNodeIds: string[] = []) =>
  c.api.call('sendMessage', {
    params: { conversationId },
    body: { clientMsgId: uuid(), text, attachmentNodeIds },
  });

const byText = async (c: Client, conversationId: string, text: string) =>
  (await list(c, conversationId)).find((m) => m.text === text)!;

async function enable(i: Instance) {
  await i.owner.api.call('updateFederation', {
    body: { enabled: true, sharedChannels: { enabled: true } },
  });
}

async function befriend(x: Instance, y: Instance) {
  await x.owner.api.call('addFederationPeer', { body: { domain: y.domain } });
  await y.owner.api.call('addFederationPeer', { body: { domain: x.domain } });
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
  a = await instance('crewhall_fed_shared_a');
  b = await instance('crewhall_fed_shared_b');
  c = await instance('crewhall_fed_shared_c', { FEDERATION_AUTO_ACCEPT_DOMAINS: a.domain });
  elif = (await join(a.app, a.owner, 'elif@milvasoft.com', 'member', [a.spaceId])).person;
  can = (await join(b.app, b.owner, 'can@acme.com', 'member', [b.spaceId])).person;
  deniz = (await join(c.app, c.owner, 'deniz@globex.com', 'member', [c.spaceId])).person;
  for (const i of [a, b, c]) {
    await i.owner.api.call('updateFederation', { body: { enabled: true } });
  }
  await befriend(a, b);
  await befriend(a, c);
  channelA = (
    await a.owner.api.call('createConversation', {
      body: { type: 'space', spaceId: a.spaceId, name: 'Ortak proje' },
    })
  ).id;
}, 180_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await c?.close();
});

describe('inviting', () => {
  it('needs shared channels on both sides and an admin', async () => {
    await expectCode(
      a.owner.api.call('shareChannel', {
        params: { conversationId: channelA },
        body: { domain: b.domain },
      }),
      403,
      'federation_shared_channels_disabled',
    );
    await enable(a);
    // B has not turned them on: its refusal comes back as the same code.
    await expectCode(
      a.owner.api.call('shareChannel', {
        params: { conversationId: channelA },
        body: { domain: b.domain },
      }),
      403,
      'federation_shared_channels_disabled',
    );
    await enable(b);
    await enable(c);
    await expectCode(
      elif.api.call('shareChannel', {
        params: { conversationId: channelA },
        body: { domain: b.domain },
      }),
      403,
      'forbidden',
    );
  });

  it('waits for the guest admin, who picks the space', async () => {
    const share = await a.owner.api.call('shareChannel', {
      params: { conversationId: channelA },
      body: { domain: b.domain },
    });
    expect(share).toMatchObject({ role: 'host', status: 'invited', domain: b.domain });
    // The same invite again is the same share.
    const again = await a.owner.api.call('shareChannel', {
      params: { conversationId: channelA },
      body: { domain: b.domain },
    });
    expect(again.id).toBe(share.id);

    const pending = (await b.owner.api.call('listSharedChannels')).items;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      role: 'guest',
      status: 'pending',
      channelName: 'Ortak proje',
      conversationId: null,
    });
    await expectCode(can.api.call('listSharedChannels'), 403, 'forbidden');
    const accepted = await b.owner.api.call('acceptSharedChannel', {
      params: { shareId: pending[0]!.id },
      body: { spaceId: b.spaceId, name: 'Milvasoft ortak' },
    });
    expect(accepted.status).toBe('active');
    channelB = accepted.conversationId!;
    await expectCode(
      b.owner.api.call('acceptSharedChannel', {
        params: { shareId: pending[0]!.id },
        body: { spaceId: b.spaceId },
      }),
      409,
      'federation_share_closed',
    );
    const hostSide = await a.owner.api.call('listConversationShares', {
      params: { conversationId: channelA },
    });
    expect(hostSide.items[0]).toMatchObject({ status: 'active', domain: b.domain });
    const conv = await can.api.call('getConversation', { params: { conversationId: channelB } });
    expect(conv.federation?.shared).toMatchObject({ role: 'guest', active: true });
  });

  it('is accepted at once by an auto-accepting peer', async () => {
    const share = await a.owner.api.call('shareChannel', {
      params: { conversationId: channelA },
      body: { domain: c.domain },
    });
    expect(share.status).toBe('active');
    const guest = (await c.owner.api.call('listSharedChannels')).items[0]!;
    expect(guest).toMatchObject({ status: 'active', channelName: 'Ortak proje' });
    channelC = guest.conversationId!;
    const conv = await a.owner.api.call('getConversation', {
      params: { conversationId: channelA },
    });
    expect(conv.federation?.shared?.orgs.map((o) => o.status)).toEqual(['active', 'active']);
  });
});

describe('messages', () => {
  it('flow between every organization through the host', async () => {
    await send(can, channelB, 'B den merhaba');
    await send(elif, channelA, 'A dan selam');
    await send(deniz, channelC, 'C den selam');
    expect(await texts(a.owner, channelA)).toEqual(
      expect.arrayContaining([
        { text: 'B den merhaba', from: `can@${b.domain}` },
        { text: 'C den selam', from: `deniz@${c.domain}` },
      ]),
    );
    // C hears B through A, and the other way round.
    expect(await texts(deniz, channelC)).toEqual(
      expect.arrayContaining([
        { text: 'B den merhaba', from: `can@${b.domain}` },
        { text: 'A dan selam', from: `elif@${a.domain}` },
      ]),
    );
    expect(await texts(can, channelB)).toEqual(
      expect.arrayContaining([{ text: 'C den selam', from: `deniz@${c.domain}` }]),
    );
  });

  it('carries edits and reactions everywhere', async () => {
    const mine = await byText(can, channelB, 'B den merhaba');
    await can.api.call('updateMessage', {
      params: { messageId: mine.id },
      body: { text: 'B den merhaba (düzeltildi)' },
    });
    expect((await texts(a.owner, channelA)).map((m) => m.text)).toContain(
      'B den merhaba (düzeltildi)',
    );
    expect((await texts(deniz, channelC)).map((m) => m.text)).toContain(
      'B den merhaba (düzeltildi)',
    );

    const onA = await byText(elif, channelA, 'B den merhaba (düzeltildi)');
    await elif.api.call('addReaction', { params: { messageId: onA.id }, body: { emoji: '👍' } });
    const onB = await byText(can, channelB, 'B den merhaba (düzeltildi)');
    expect(onB.reactions).toEqual([
      expect.objectContaining({ emoji: '👍', count: 1, remoteNames: ['elif'] }),
    ]);
    const onC = await byText(deniz, channelC, 'B den merhaba (düzeltildi)');
    await deniz.api.call('addReaction', { params: { messageId: onC.id }, body: { emoji: '👍' } });
    expect((await byText(can, channelB, 'B den merhaba (düzeltildi)')).reactions[0]?.count).toBe(2);
    await elif.api.call('removeReaction', {
      params: { messageId: onA.id },
      body: { emoji: '👍' },
    });
    expect((await byText(can, channelB, 'B den merhaba (düzeltildi)')).reactions[0]).toMatchObject({
      count: 1,
      remoteNames: ['deniz'],
    });
  });

  it('deletes by author and host everywhere, a guest moderator only locally', async () => {
    await send(can, channelB, 'silinecek B');
    const own = await byText(can, channelB, 'silinecek B');
    await can.api.call('deleteMessage', { params: { messageId: own.id } });
    expect((await texts(a.owner, channelA)).map((m) => m.text)).not.toContain('silinecek B');
    expect((await texts(deniz, channelC)).map((m) => m.text)).not.toContain('silinecek B');

    await send(deniz, channelC, 'moderasyon');
    const onA = await byText(a.owner, channelA, 'moderasyon');
    await a.owner.api.call('deleteMessage', { params: { messageId: onA.id } });
    expect((await texts(deniz, channelC)).map((m) => m.text)).not.toContain('moderasyon');
    expect((await texts(can, channelB)).map((m) => m.text)).not.toContain('moderasyon');

    // B's admin removes A's message from B only.
    const fromA = await byText(b.owner, channelB, 'A dan selam');
    await b.owner.api.call('deleteMessage', { params: { messageId: fromA.id } });
    expect((await texts(b.owner, channelB)).map((m) => m.text)).not.toContain('A dan selam');
    expect((await texts(a.owner, channelA)).map((m) => m.text)).toContain('A dan selam');
    expect((await texts(deniz, channelC)).map((m) => m.text)).toContain('A dan selam');
  });

  it('copies files into each organization’s own Drive', async () => {
    const folder = await can.api.call('getChatAttachmentFolder', {
      params: { conversationId: channelB },
    });
    const file = await uploadFile(can, {
      spaceId: folder.spaceId,
      parentId: folder.folderId,
      name: 'teklif.txt',
      content: Buffer.from('teklif metni'),
      mime: 'text/plain',
    });
    await send(can, channelB, 'ekte teklif', [file.node.id]);
    for (const [who, conv] of [
      [a.owner, channelA],
      [deniz, channelC],
    ] as const) {
      const msg = await byText(who, conv, 'ekte teklif');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]).toMatchObject({ name: 'teklif.txt', sizeBytes: 12 });
      expect(msg.attachments[0]!.nodeId).not.toBe(file.node.id);
    }
  });

  it('refuses a blocked person on the host', async () => {
    const conv = await a.owner.api.call('blockRemoteMember', {
      params: { conversationId: channelA },
      body: { address: `can@${b.domain}`, blocked: true },
    });
    expect(conv.federation?.blocked).toEqual([`can@${b.domain}`]);
    await send(can, channelB, 'engelliyken');
    expect((await texts(a.owner, channelA)).map((m) => m.text)).not.toContain('engelliyken');
    expect((await texts(deniz, channelC)).map((m) => m.text)).not.toContain('engelliyken');
    await a.owner.api.call('blockRemoteMember', {
      params: { conversationId: channelA },
      body: { address: `can@${b.domain}`, blocked: false },
    });
    await send(can, channelB, 'engel kalktı');
    expect((await texts(a.owner, channelA)).map((m) => m.text)).toContain('engel kalktı');
  });
});

describe('leaving and removing', () => {
  it('leaves a read-only copy on the side that loses the channel', async () => {
    const guest = (await b.owner.api.call('listSharedChannels')).items[0]!;
    const left = await b.owner.api.call('endSharedChannel', { params: { shareId: guest.id } });
    expect(left.status).toBe('left');
    const copy = await can.api.call('getConversation', { params: { conversationId: channelB } });
    expect(copy.archivedAt).not.toBeNull();
    const hostSide = await a.owner.api.call('listConversationShares', {
      params: { conversationId: channelA },
    });
    expect(hostSide.items.find((s) => s.domain === b.domain)?.status).toBe('left');
    await send(elif, channelA, 'B gitti');
    expect((await texts(can, channelB)).map((m) => m.text)).not.toContain('B gitti');
    expect((await texts(deniz, channelC)).map((m) => m.text)).toContain('B gitti');
  });
});

describe('a reset guest (the hourly demo)', () => {
  it('gets the channel back after adding the host again', async () => {
    // C's database is emptied: links, shares and the peer go, the key stays (demo key).
    const db = c.app.deps.db;
    await db.execute(sql`delete from conversations where id = ${channelC}::uuid`);
    await db.delete(federationPeers);
    await db.update(federationKeys).set({ instanceId: sql`gen_random_uuid()` });
    await c.owner.api.call('addFederationPeer', { body: { domain: a.domain } });

    const shares = (await c.owner.api.call('listSharedChannels')).items;
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ status: 'active', channelName: 'Ortak proje' });
    const fresh = shares[0]!.conversationId!;
    expect(fresh).not.toBe(channelC);
    await send(elif, channelA, 'sıfırlamadan sonra');
    expect((await texts(deniz, fresh)).map((m) => m.text)).toEqual(['sıfırlamadan sonra']);
    await send(deniz, fresh, 'C geri döndü');
    expect((await texts(a.owner, channelA)).map((m) => m.text)).toContain('C geri döndü');
  });

  it('derives the demo key from the secret alone', () => {
    const der = (secret: string) =>
      demoKeyPair(secret).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(der('secret-one')).toBe(der('secret-one'));
    expect(der('secret-one')).not.toBe(der('secret-two'));
  });

  it('ends the shares when the host archives the channel', async () => {
    await a.owner.api.call('updateConversation', {
      params: { conversationId: channelA },
      body: { archived: true },
    });
    const guest = (await c.owner.api.call('listSharedChannels')).items[0]!;
    expect(guest.status).toBe('ended');
    const copy = await deniz.api.call('getConversation', {
      params: { conversationId: guest.conversationId! },
    });
    expect(copy.archivedAt).not.toBeNull();
    const peer = await a.app.deps.db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.domain, c.domain));
    expect(peer[0]?.remoteInstanceId).not.toBeNull();
  });
});
