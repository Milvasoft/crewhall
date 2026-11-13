import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '@crewhall/db';
import type { Message } from '@crewhall/shared';
import { clearLinkPreviewCache } from '../src/services/chat/link-preview';
import { listen, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Link preview cards (kararlar.md 2026-11-13); the linked site is a local stub. */

const hits: string[] = [];
let stub: Server;
let site: string;

const PAGE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Release notes &amp; plans">
<meta content="What changed in November." name="description">
<meta property="og:site_name" content="Example Blog">
<meta property="og:image" content="https://cdn.example.com/cover.png">
</head><body>hello</body></html>`;

let app: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let owner: Client;
let elif: Client;
let groupId: string;

beforeAll(async () => {
  stub = createServer((req, res) => {
    hits.push(req.url ?? '/');
    if (req.url === '/plain') {
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    if (req.url === '/no-image') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><head><title>Just a title</title><meta property="og:image" content="http://insecure.example/x.png"></head></html>',
      );
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  app = await createTestApp();
  server = await listen(app);
  owner = (await setupWithOwner(app)).owner;
  const spaces = await owner.api.call('listSpaces');
  const spaceId = spaces.items.find((s) => s.name === 'Milvasoft')!.id;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId])).person;
  const elifId = (await elif.api.call('me')).user.id;
  groupId = (
    await owner.api.call('createConversation', { body: { type: 'direct', userId: elifId } })
  ).id;
});

afterAll(async () => {
  await server.close();
  await app.close();
  await new Promise<void>((r) => stub.close(() => r()));
});

beforeEach(() => {
  clearLinkPreviewCache();
  hits.length = 0;
});

const send = (c: Client, text: string) =>
  c.api.call('sendMessage', {
    params: { conversationId: groupId },
    body: { clientMsgId: uuid(), text },
  });

async function fetched(c: Client, id: string) {
  const page = await c.api.call('listMessages', {
    params: { conversationId: groupId },
    query: { limit: 50 },
  });
  return page.items.find((m) => m.id === id)!;
}

/** Waits for the job: the card or its absence must settle in the database. */
async function settle(id: string, pred: (m: Message) => boolean) {
  return vi.waitFor(
    async () => {
      const m = await fetched(owner, id);
      if (!pred(m)) throw new Error('not yet');
      return m;
    },
    { timeout: 10_000, interval: 50 },
  );
}

describe('chat link previews', () => {
  it('reads the card after sending and pushes it with message.updated', async () => {
    const ws = await WsClient.open(server.port, elif);
    const sent = await send(owner, `Bakın *şuna*: ${site}/post?id=1 ve https://localhost:5173/x`);
    const event = await ws.waitFor(
      'message.updated',
      (e) => e.message.id === sent.id && !!e.message.linkPreview,
    );
    expect(event.message.linkPreview).toEqual({
      url: `${site}/post?id=1`,
      title: 'Release notes & plans',
      description: 'What changed in November.',
      siteName: 'Example Blog',
      imageUrl: 'https://cdn.example.com/cover.png',
    });
    expect(hits).toEqual(['/post?id=1']);
    expect((await fetched(elif, sent.id)).linkPreview?.title).toBe('Release notes & plans');
    ws.ws.close();
  });

  it('skips code, its own addresses and pages that are not HTML; keeps http images out', async () => {
    const own = await send(owner, `\`${site}/in-code\` ve ${app.deps.env.HUB_URL}/chat`);
    const plain = await send(owner, `${site}/plain`);
    const noImage = await send(owner, `${site}/no-image`);
    const m = await settle(noImage.id, (x) => !!x.linkPreview);
    expect(m.linkPreview).toMatchObject({ title: 'Just a title', imageUrl: null });
    expect(m.linkPreview?.siteName).toBe(new URL(site).host);
    await vi.waitFor(() => expect(hits).toContain('/plain'));
    expect(hits).not.toContain('/in-code');
    expect((await fetched(owner, own.id)).linkPreview ?? null).toBeNull();
    expect((await fetched(owner, plain.id)).linkPreview ?? null).toBeNull();
  });

  it('never reads private addresses outside the allowlist', async () => {
    const sent = await send(owner, 'http://10.255.255.1/admin ve http://169.254.169.254/latest');
    // The job ran: the message is untouched and nothing reached the stub.
    await new Promise((r) => setTimeout(r, 300));
    const [row] = await app.deps.db.select().from(messages).where(eq(messages.id, sent.id));
    expect(row?.body.linkPreview).toBeUndefined();
    expect(hits).toEqual([]);
  });

  it('lets only the author remove the card, which stays away after an edit', async () => {
    const sent = await send(owner, `${site}/remove-me`);
    await settle(sent.id, (m) => !!m.linkPreview);
    await expect(
      elif.api.call('removeChatLinkPreview', { params: { messageId: sent.id } }),
    ).rejects.toMatchObject({ code: 'chat_message_not_editable' });
    const ws = await WsClient.open(server.port, elif);
    const removed = await owner.api.call('removeChatLinkPreview', {
      params: { messageId: sent.id },
    });
    expect(removed.linkPreview ?? null).toBeNull();
    await ws.waitFor('message.updated', (e) => e.message.id === sent.id && !e.message.linkPreview);
    ws.ws.close();
    hits.length = 0;
    await owner.api.call('updateMessage', {
      params: { messageId: sent.id },
      body: { text: `${site}/other düzeltildi` },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toEqual([]);
    expect((await fetched(owner, sent.id)).linkPreview ?? null).toBeNull();
  });

  it('follows edits: a new address replaces the card, no address clears it', async () => {
    const sent = await send(owner, `${site}/first`);
    await settle(sent.id, (m) => m.linkPreview?.url === `${site}/first`);
    await owner.api.call('updateMessage', {
      params: { messageId: sent.id },
      body: { text: `${site}/second` },
    });
    await settle(sent.id, (m) => m.linkPreview?.url === `${site}/second`);
    await owner.api.call('updateMessage', {
      params: { messageId: sent.id },
      body: { text: 'artık bağlantı yok' },
    });
    await settle(sent.id, (m) => !m.linkPreview);
  });

  it('is off when the org turns it off', async () => {
    await owner.api.call('updateOrg', { body: { settings: { chatLinkPreviews: false } } });
    try {
      const sent = await send(owner, `${site}/off`);
      await new Promise((r) => setTimeout(r, 300));
      expect(hits).toEqual([]);
      expect((await fetched(owner, sent.id)).linkPreview ?? null).toBeNull();
    } finally {
      await owner.api.call('updateOrg', { body: { settings: { chatLinkPreviews: true } } });
    }
  });
});
