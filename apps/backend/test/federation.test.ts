import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { messages, runMigrations } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { newActivity, postActivity } from '../src/services/federation/core';
import { uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Federation (roadmap 26): two installations, each with its own database and HTTP server,
 * talking over signed requests on real sockets.
 */

interface Instance {
  app: TestApp;
  port: number;
  domain: string;
  owner: Client;
  orgId: string;
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

/** A second database in the test Postgres, migrated like the first. */
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

async function instance(databaseUrl?: string): Promise<Instance> {
  const port = await freePort();
  const app = await createTestApp({
    API_URL: `http://127.0.0.1:${port}`,
    FEDERATION_ALLOW_HTTP: 'true',
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    ) as Server;
  });
  app.realtime.attach(server);
  const { owner, orgId } = await setupWithOwner(app);
  return {
    app,
    port,
    domain: `127.0.0.1:${port}`,
    owner,
    orgId,
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

const texts = async (c: Client, conversationId: string) =>
  (await c.api.call('listMessages', { params: { conversationId }, query: {} })).items
    .filter((m) => m.kind === 'user')
    .map((m) => ({ text: m.text, from: m.remoteAuthor?.address ?? m.author?.email ?? null }));

const send = (c: Client, conversationId: string, text: string) =>
  c.api.call('sendMessage', { params: { conversationId }, body: { clientMsgId: uuid(), text } });

let a: Instance;
let b: Instance;
let elif: Client;
let mert: Client;
let elifId: string;
let mertId: string;
let can: Client;
let canAddress: string;

beforeAll(async () => {
  a = await instance();
  b = await instance(await freshDatabase('crewhall_federation_b'));
  const spaceA = (await a.owner.api.call('listSpaces')).items.find(
    (s) => s.name === 'Milvasoft',
  )!.id;
  const e = await join(a.app, a.owner, 'elif@milvasoft.com', 'member', [spaceA]);
  elif = e.person;
  elifId = e.me.user.id;
  const m = await join(a.app, a.owner, 'mert@milvasoft.com', 'member', [spaceA]);
  mert = m.person;
  mertId = m.me.user.id;
  can = (await join(b.app, b.owner, 'can.yilmaz@acme.com', 'member')).person;
  canAddress = `can.yilmaz@${b.domain}`;
}, 120_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
});

describe('federation off', () => {
  it('has no discovery document and refuses federated actions', async () => {
    const res = await fetch(`http://${a.domain}/.well-known/crewhall-federation`);
    expect(res.status).toBe(404);
    await expectCode(
      a.owner.api.call('createRemoteConversation', { body: { address: canAddress } }),
      403,
      'federation_disabled',
    );
    expect((await a.owner.api.call('getMyFederationAddress')).enabled).toBe(false);
  });
});

describe('mutual registration', () => {
  it('turns active once both sides added each other', async () => {
    await a.owner.api.call('updateFederation', { body: { enabled: true } });
    await b.owner.api.call('updateFederation', { body: { enabled: true } });
    const doc = (await (
      await fetch(`http://${a.domain}/.well-known/crewhall-federation`)
    ).json()) as {
      domain: string;
      publicKey: string;
    };
    expect(doc.domain).toBe(a.domain);

    const pending = await a.owner.api.call('addFederationPeer', { body: { domain: b.domain } });
    expect(pending.status).toBe('pending');
    const bSide = await b.owner.api.call('getFederation');
    const request = bSide.peers.find((p) => p.domain === a.domain)!;
    expect(request).toMatchObject({ status: 'pending', requested: true });
    // Both admins can compare the same fingerprint aloud.
    expect(request.fingerprint).toBe((await a.owner.api.call('getFederation')).fingerprint);

    const accepted = await b.owner.api.call('addFederationPeer', { body: { domain: a.domain } });
    expect(accepted.status).toBe('active');
    const aSide = await a.owner.api.call('getFederation');
    expect(aSide.peers.find((p) => p.domain === b.domain)?.status).toBe('active');
    expect(aSide.allowedDomains).toContain(b.domain);
  });

  it('refuses self, unreachable domains and members who are not admins', async () => {
    await expectCode(
      a.owner.api.call('addFederationPeer', { body: { domain: a.domain } }),
      422,
      'federation_domain_self',
    );
    await expectCode(
      a.owner.api.call('addFederationPeer', { body: { domain: `127.0.0.1:${await freePort()}` } }),
      502,
      'federation_peer_unreachable',
    );
    await expectCode(elif.api.call('getFederation'), 403, 'forbidden');
  });
});

describe('direct chat across installations', () => {
  let dmA: string;
  let dmB: string;

  it('gives people their handle@domain and finds a remote person', async () => {
    expect((await a.owner.api.call('getMyFederationAddress')).address).toBe(`bugra@${a.domain}`);
    const found = await a.owner.api.call('lookupRemoteUser', { query: { address: canAddress } });
    expect(found).toMatchObject({ address: canAddress, domain: b.domain });
    await expectCode(
      a.owner.api.call('lookupRemoteUser', { query: { address: `nobody@${b.domain}` } }),
      404,
      'federation_user_not_found',
    );
  });

  it('delivers messages both ways, live on the other side', async () => {
    const conv = await a.owner.api.call('createRemoteConversation', {
      body: { address: canAddress },
    });
    dmA = conv.id;
    expect(conv.type).toBe('direct');
    expect(conv.federation).toMatchObject({
      homeDomain: a.domain,
      domains: [b.domain],
      active: true,
    });
    expect(conv.federation?.remoteMembers.map((m) => m.address)).toEqual([canAddress]);
    // The same pair answers the same conversation.
    expect(
      (await a.owner.api.call('createRemoteConversation', { body: { address: canAddress } })).id,
    ).toBe(dmA);

    const ws = await WsClient.open(b.port, can);
    await send(a.owner, dmA, `Merhaba Can, <@${elifId}> da selam söylüyor`);
    const live = await ws.waitFor('message.created', (e) => e.message.text.startsWith('Merhaba'));
    await ws.close();
    dmB = live.message.conversationId;
    expect(live.message.remoteAuthor).toEqual({
      address: `bugra@${a.domain}`,
      name: 'Ahmet Buğra Kösen',
      domain: a.domain,
    });
    // Local mention tokens arrive as plain names, never as ids of the other installation.
    expect(live.message.text).toBe('Merhaba Can, @elif da selam söylüyor');

    const list = (await can.api.call('listConversations', { query: {} })).items;
    const mirror = list.find((c) => c.id === dmB)!;
    expect(mirror).toMatchObject({ type: 'direct', title: 'Ahmet Buğra Kösen' });
    expect(mirror.federation?.homeDomain).toBe(a.domain);
    expect(mirror.my.unread).toBe(1);

    await send(can, dmB, 'Selam, aldım');
    expect(await texts(a.owner, dmA)).toEqual([
      { text: `Merhaba Can, <@${elifId}> da selam söylüyor`, from: 'bugra@milvasoft.com' },
      { text: 'Selam, aldım', from: canAddress },
    ]);
  });

  it('applies a replayed activity once and rejects a bad signature', async () => {
    const activity = newActivity('message.create', {
      conversationId: dmB,
      message: {
        id: uuid(),
        from: { address: `bugra@${a.domain}`, name: 'Ahmet Buğra Kösen' },
        text: 'bir kez',
        createdAt: new Date().toISOString(),
      },
    });
    const first = await postActivity(a.app.deps, a.orgId, b.domain, activity);
    const again = await postActivity(a.app.deps, a.orgId, b.domain, activity);
    expect(again).toEqual(first);
    const rows = await b.app.deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, dmB));
    expect(rows.filter((r) => r.text === 'bir kez')).toHaveLength(1);

    const res = await fetch(`http://${b.domain}/api/federation/v1/inbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Signature-Input': `sig1=("@method" "@target-uri" "content-digest" "content-type");created=${Math.floor(Date.now() / 1000)};keyid="${a.domain}";nonce="x";alg="ed25519"`,
        Signature: 'sig1=:AAAA:',
        'Content-Digest': 'sha-256=:AAAA:',
      },
      body: JSON.stringify(newActivity('user.lookup', { handle: 'can.yilmaz' })),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('federation_signature_invalid');
  });

  it('refuses a message on behalf of someone from another domain', async () => {
    // Only the home may relay; B speaking for an A address is refused.
    await expect(
      postActivity(
        b.app.deps,
        b.orgId,
        a.domain,
        newActivity('message.create', {
          conversationId: dmA,
          message: {
            id: uuid(),
            from: { address: `elif@${a.domain}`, name: 'Elif' },
            text: 'sahte',
            createdAt: new Date().toISOString(),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'federation_not_allowed' });
  });
});

describe('channels with remote people', () => {
  it('relays a group conversation between both installations', async () => {
    const group = await a.owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, mertId], name: 'Ortak proje' },
    });
    const withCan = await a.owner.api.call('addRemoteConversationMember', {
      params: { conversationId: group.id },
      body: { address: canAddress },
    });
    expect(withCan.federation?.remoteMembers.map((m) => m.address)).toEqual([canAddress]);

    await send(elif, group.id, 'Toplantı saat üçte');
    const mirror = (await can.api.call('listConversations', { query: {} })).items.find(
      (c) => c.title === 'Ortak proje',
    )!;
    expect(mirror.type).toBe('group');
    expect(await texts(can, mirror.id)).toEqual([
      { text: 'Toplantı saat üçte', from: `elif@${a.domain}` },
    ]);
    await send(can, mirror.id, 'Uygun');
    expect((await texts(mert, group.id)).at(-1)).toEqual({ text: 'Uygun', from: canAddress });

    // Someone on B who was not added cannot speak in A's channel.
    await expect(
      postActivity(
        b.app.deps,
        b.orgId,
        a.domain,
        newActivity('message.create', {
          conversationId: group.id,
          message: {
            id: uuid(),
            from: { address: `bugra@${b.domain}`, name: 'Davetsiz' },
            text: 'ben de',
            createdAt: new Date().toISOString(),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'federation_not_allowed' });
    // Only the conversation's home adds remote people.
    await expectCode(
      can.api.call('addRemoteConversationMember', {
        params: { conversationId: mirror.id },
        body: { address: `bugra@${a.domain}` },
      }),
      403,
    );
  });
});

describe('sharing a page or file', () => {
  it('sends a link share as a direct message', async () => {
    const spaceA = (await a.owner.api.call('listSpaces')).items.find(
      (s) => s.name === 'Milvasoft',
    )!.id;
    const folder = await a.owner.api.call('createFolder', {
      params: { spaceId: spaceA },
      body: { parentId: null, name: 'Teklif dosyaları' },
    });
    const shared = await a.owner.api.call('shareNodeRemote', {
      params: { nodeId: folder.id },
      body: { address: canAddress, note: 'Bakabilir misin?' },
    });
    expect(shared.url).toContain('/s/');
    const dm = (await can.api.call('listConversations', { query: {} })).items.find(
      (c) => c.type === 'direct' && c.federation,
    )!;
    const last = (await texts(can, dm.id)).at(-1)!;
    expect(last.text).toBe(`Bakabilir misin?\n\nTeklif dosyaları: ${shared.url}`);
  });
});

describe('removing a peer', () => {
  it('stops delivery and marks the conversations read-only', async () => {
    const peer = (await b.owner.api.call('getFederation')).peers.find(
      (p) => p.domain === a.domain,
    )!;
    await b.owner.api.call('removeFederationPeer', { params: { peerId: peer.id } });
    const aPeer = (await a.owner.api.call('getFederation')).peers.find(
      (p) => p.domain === b.domain,
    )!;
    expect(aPeer.status).toBe('pending');
    const dm = (await a.owner.api.call('listConversations', { query: {} })).items.find(
      (c) => c.federation?.domains.includes(b.domain) && c.type === 'direct',
    )!;
    expect(dm.federation?.active).toBe(false);
    const before = (
      await texts(
        can,
        (await can.api.call('listConversations', { query: {} })).items.find(
          (c) => c.type === 'direct' && c.federation,
        )!.id,
      )
    ).length;
    await send(a.owner, dm.id, 'gitmeyecek');
    const after = (
      await texts(
        can,
        (await can.api.call('listConversations', { query: {} })).items.find(
          (c) => c.type === 'direct' && c.federation,
        )!.id,
      )
    ).length;
    expect(after).toBe(before);
    await expectCode(
      a.owner.api.call('lookupRemoteUser', { query: { address: canAddress } }),
      409,
      'federation_peer_not_active',
    );
  });
});
