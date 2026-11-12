import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications } from '@crewhall/db';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, linkFromMail, setupWithOwner, type TestApp } from './helpers';

/** English web paths (docs/contracts/ingilizce-url.md) on the backend side. */
describe('English web paths', () => {
  let app: TestApp;
  let owner: Client;
  let elif: Client;
  let elifId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    elif = (await join(app, owner, 'elif@milvasoft.com', 'member')).person;
    elifId = (await elif.api.call('me')).user.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('sends old invitation links on to /invite, query and all', async () => {
    for (const method of ['GET', 'HEAD']) {
      const res = await app.app.request('http://localhost:3000/davet/tok%2Fx?from=mail', {
        method,
      });
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/invite/tok%2Fx?from=mail');
    }
  });

  it('leaves WebDAV under /dav as it was', async () => {
    const res = await app.app.request('http://localhost:3000/dav/', { method: 'PROPFIND' });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });

  it('writes invitation mail with the English path', async () => {
    const inv = await owner.api.call('createInvitation', {
      body: { email: 'deniz@milvasoft.com', role: 'member' },
    });
    expect(inv.url).toMatch(/^http:\/\/localhost:5173\/invite\//);
    expect(linkFromMail(app, 'deniz@milvasoft.com', 'http://localhost:5173/invite/')).toBe(inv.url);
  });

  it('hands out the current path for a notification stored with an old one', async () => {
    const dm = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    const msg = await owner.api.call('sendMessage', {
      params: { conversationId: dm.id },
      body: { clientMsgId: uuid(), text: 'eski bildirim' },
    });
    const [row] = await app.deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.targetId, msg.id));
    expect(row!.url).toBe(`/chat/c/${dm.id}?seq=${msg.seq}`);
    await app.deps.db
      .update(notifications)
      .set({ url: '/toplantilar/oda/haftalik?arama=c1' })
      .where(eq(notifications.id, row!.id));
    const list = await elif.api.call('listNotifications', { query: {} });
    expect(list.items.find((n) => n.id === row!.id)?.url).toBe('/meetings/room/haftalik?call=c1');
  });
});
