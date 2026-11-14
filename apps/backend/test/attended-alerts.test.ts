import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, WsServerEvent } from '@crewhall/shared';
import { withAttended } from '../src/realtime/gateway';
import {
  createNotifications,
  deliverNotifications,
  type NotificationInput,
} from '../src/services/notifications/notify';
import { listen, until, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * One rule for where a notification makes noise (API 55): while the person is at a session, the
 * live events say so (`attended`) and only that session chimes or shows an OS notification;
 * when they are at none, every device does. Calls and urgent ones ring everywhere.
 */
describe('attended on live events', () => {
  let app: TestApp;
  let server: Awaited<ReturnType<typeof listen>>;
  let owner: Client;
  let orgId: string;
  let elif: Client;
  let elifId: string;
  let directId: string;
  /** The PC the person works at: a focused web tab. */
  let atPc: WsClient;
  /** Another session of theirs nobody looks at (a tab in the background, a PC left on). */
  let other: WsClient;

  const beat = (ws: WsClient, idleSeconds: number) =>
    ws.send({ type: 'heartbeat', active: true, focused: true, client: 'web', idleSeconds });

  const send = async (text: string) => {
    const m = await owner.api.call('sendMessage', {
      params: { conversationId: directId },
      body: { clientMsgId: uuid(), text },
    });
    const created = (ws: WsClient) => ws.waitFor('message.created', (e) => e.message.id === m.id);
    const note = (ws: WsClient) =>
      ws.waitFor('notification', (e) => e.notification.data.excerpt === text);
    return {
      created: await Promise.all([created(atPc), created(other)]),
      notes: await Promise.all([note(atPc), note(other)]),
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    server = await listen(app);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    const e = await join(app, owner, 'elif@milvasoft.com', 'member');
    elif = e.person;
    elifId = e.me.user.id;
    directId = (
      await owner.api.call('createConversation', { body: { type: 'direct', userId: elifId } })
    ).id;
    atPc = await WsClient.open(server.port, elif);
    other = await WsClient.open(server.port, elif);
    await Promise.all([atPc.waitFor('ready'), other.waitFor('ready')]);
    other.send({ type: 'heartbeat', active: false, focused: false, client: 'web' });
  });

  afterAll(async () => {
    await atPc?.close();
    await other?.close();
    await server.close();
    await app?.close();
  });

  it('says attended while a focused web session has fresh input, on every session', async () => {
    beat(atPc, 3);
    await until(() => app.deps.presence.hasFocusedSession(elifId));
    const { created, notes } = await send('buradayım');
    expect(created.map((e) => e.attended)).toEqual([true, true]);
    expect(notes.map((e) => e.attended)).toEqual([true, true]);
  });

  it('says not attended once the person left the PC (the tab stays visible)', async () => {
    beat(atPc, 600);
    await until(() => !app.deps.presence.hasFocusedSession(elifId));
    const { created, notes } = await send('neredesin');
    expect(created.map((e) => e.attended)).toEqual([false, false]);
    expect(notes.map((e) => e.attended)).toEqual([false, false]);
  });

  it('leaves it out on my own messages', async () => {
    beat(atPc, 3);
    await until(() => app.deps.presence.hasFocusedSession(elifId));
    const m = await elif.api.call('sendMessage', {
      params: { conversationId: directId },
      body: { clientMsgId: uuid(), text: 'benden' },
    });
    const mine = await other.waitFor('message.created', (e) => e.message.id === m.id);
    expect(mine.attended).toBeUndefined();
  });

  it('never says attended for urgent ones and calls, which ring everywhere', async () => {
    beat(atPc, 3);
    await until(() => app.deps.presence.hasFocusedSession(elifId));
    const input = (excerpt: string, extra: Partial<NotificationInput>): NotificationInput => ({
      orgId,
      userId: elifId,
      type: 'chat.alert',
      category: 'alert',
      actorId: null,
      target: { type: 'conversation', id: directId },
      data: { excerpt },
      url: '/chat',
      ...extra,
    });
    const rows = await createNotifications(
      app.deps.db,
      [
        input('sıradan', {}),
        input('kritik', { urgent: true }),
        input('çağrı', { type: 'meet.call', category: 'meetings', everyDevice: true }),
      ],
      app.deps.presence,
    );
    expect(rows).toHaveLength(3);
    await deliverNotifications(app.deps, rows);
    const attended = async (excerpt: string) =>
      (await other.waitFor('notification', (e) => e.notification.data.excerpt === excerpt))
        .attended;
    expect(await attended('sıradan')).toBe(true);
    expect(await attended('kritik')).toBe(false);
    expect(await attended('çağrı')).toBe(false);
  });
});

describe('withAttended', () => {
  const event = (message: Partial<Message>): WsServerEvent => ({
    type: 'message.created',
    conversationId: 'c1',
    message: { kind: 'text', text: 'selam', card: null, author: null, ...message } as Message,
  });
  const here = { hasFocusedSession: () => true };

  it('marks others’ messages, but critical alerts ring everywhere', () => {
    expect(withAttended(here, 'u1', event({}))).toMatchObject({ attended: true });
    expect(withAttended({ hasFocusedSession: () => false }, 'u1', event({}))).toMatchObject({
      attended: false,
    });
    const critical = event({ kind: 'webhook', text: 'down', severity: 'critical' });
    expect(withAttended(here, 'u1', critical)).toMatchObject({ attended: false });
  });

  it('leaves other events and my own messages alone', () => {
    const mine = event({ author: { id: 'u1' } as Message['author'] });
    expect(withAttended(here, 'u1', mine)).toBe(mine);
    const other: WsServerEvent = { type: 'notifications.changed', unreadCount: 1 };
    expect(withAttended(here, 'u1', other)).toBe(other);
  });
});
