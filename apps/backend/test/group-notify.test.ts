import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationMembers, notifications } from '@crewhall/db';
import { listen, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** The user's decision of 2026-11-05: group messages push by default, channels stay at mentions. */
describe('group messages notify by default', () => {
  let app: TestApp;
  let server: Awaited<ReturnType<typeof listen>>;
  let owner: Client;
  let elif: Client;
  let elifId: string;
  let canId: string;
  let spaceId: string;
  let orgId: string;

  const send = (c: Client, conversationId: string, text: string) =>
    c.api.call('sendMessage', {
      params: { conversationId },
      body: { clientMsgId: uuid(), text },
    });
  const group = () =>
    owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, canId] },
    });
  const channel = () =>
    owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: `kanal-${uuid().slice(0, 8)}` },
    });
  const level = async (conversationId: string, userId = elifId) =>
    (
      await app.deps.db
        .select({ notify: conversationMembers.notify })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        )
    )[0]?.notify;
  /** Back to how a row looked before the default changed, never touched. */
  const asOldRow = (conversationId: string) =>
    app.deps.db
      .update(conversationMembers)
      .set({ notify: 'mentions', updatedAt: sql`${conversationMembers.createdAt}` })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, elifId),
        ),
      );
  const heard = (messageId: string) =>
    app.deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, elifId), eq(notifications.targetId, messageId)));

  beforeAll(async () => {
    app = await createTestApp();
    server = await listen(app);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    const spaces = await owner.api.call('listSpaces');
    spaceId = spaces.items.find((x) => x.name === 'Milvasoft')!.id;
    const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
    elif = e.person;
    elifId = e.me.user.id;
    canId = (await join(app, owner, 'can@milvasoft.com', 'member', [spaceId])).me.user.id;
  });

  afterAll(async () => {
    await server.close();
    await app?.close();
  });

  it('a plain group message wants a push; e-mail stays off', async () => {
    const g = await group();
    expect(await level(g.id)).toBe('all');
    const m = await send(owner, g.id, 'selam ekip');
    const [row] = await heard(m.id);
    expect(row).toMatchObject({ type: 'chat.message', wantsPush: true, wantsEmail: false });
  });

  it('someone added later gets the same default', async () => {
    const g = await group();
    const late = await join(app, owner, 'late@milvasoft.com', 'member');
    await owner.api.call('addConversationMembers', {
      params: { conversationId: g.id },
      body: { userIds: [late.me.user.id], history: 'none' },
    });
    expect(await level(g.id, late.me.user.id)).toBe('all');
  });

  it('a space channel stays at mentions', async () => {
    const c = await channel();
    await elif.api.call('updateMyConversation', {
      params: { conversationId: c.id },
      body: { pinned: true },
    });
    expect(await level(c.id)).toBe('mentions');
    const m = await send(owner, c.id, 'herkese duyuru');
    expect(await heard(m.id)).toEqual([]);
  });

  it('choosing mentions or none in a group is respected', async () => {
    const g = await group();
    await elif.api.call('updateMyConversation', {
      params: { conversationId: g.id },
      body: { notify: 'mentions' },
    });
    const m = await send(owner, g.id, 'düz mesaj');
    expect(await heard(m.id)).toEqual([]);
    await elif.api.call('updateMyConversation', {
      params: { conversationId: g.id },
      body: { notify: 'none' },
    });
    const n = await send(owner, g.id, `<@${elifId}> sana`);
    expect(await heard(n.id)).toEqual([]);
  });

  it('a muted group does not ring', async () => {
    const g = await group();
    await elif.api.call('updateMyConversation', {
      params: { conversationId: g.id },
      body: { mutedUntil: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const m = await send(owner, g.id, 'sessiz');
    expect(await heard(m.id)).toEqual([]);
  });

  it('at the PC it stays quiet, as with direct messages', async () => {
    const g = await group();
    const t = await elif.api.call('createWsTicket');
    const ws = await WsClient.openWithTicket(server.port, t.ticket);
    await ws.waitFor('ready');
    ws.send({ type: 'heartbeat', active: true, focused: true, client: 'web', idleSeconds: 1 });
    await expect.poll(() => app.deps.presence.hasFocusedSession(elifId)).toBe(true);
    const m = await send(owner, g.id, 'başındasın');
    const [row] = await heard(m.id);
    // Held while at the PC; the phone gets it only if it is still unread afterwards.
    expect(row).toMatchObject({ wantsPush: true, pushSkip: 'attending' });
    await ws.close();
  });

  it('the backfill moves only rows nobody chose', async () => {
    const untouched = await group();
    await asOldRow(untouched.id);

    const pinned = await group();
    await asOldRow(pinned.id);
    await elif.api.call('updateMyConversation', {
      params: { conversationId: pinned.id },
      body: { pinned: true },
    });

    // All → back to mentions: the only way to choose it while it was the default.
    const chose = await group();
    await elif.api.call('updateMyConversation', {
      params: { conversationId: chose.id },
      body: { notify: 'mentions' },
    });

    const none = await group();
    await elif.api.call('updateMyConversation', {
      params: { conversationId: none.id },
      body: { notify: 'none' },
    });

    const muted = await group();
    await asOldRow(muted.id);
    await elif.api.call('updateMyConversation', {
      params: { conversationId: muted.id },
      body: { mutedUntil: new Date(Date.now() + 3_600_000).toISOString() },
    });

    const archived = await group();
    await asOldRow(archived.id);
    await elif.api.call('updateMyConversation', {
      params: { conversationId: archived.id },
      body: { archived: true },
    });

    const c = await channel();
    await app.deps.db.insert(conversationMembers).values({
      conversationId: c.id,
      userId: elifId,
      orgId,
      notify: 'mentions',
    });

    const file = fileURLToPath(
      new URL('../../../packages/db/migrations/0074_group_notify_all.sql', import.meta.url),
    );
    await app.deps.db.execute(sql.raw(readFileSync(file, 'utf8')));

    expect(await level(untouched.id)).toBe('all');
    expect(await level(pinned.id)).toBe('all');
    expect(await level(chose.id)).toBe('mentions');
    expect(await level(none.id)).toBe('none');
    expect(await level(muted.id)).toBe('mentions');
    expect(await level(archived.id)).toBe('mentions');
    expect(await level(c.id)).toBe('mentions');
  });
});
