import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { notifications } from '@crewhall/db';
import { paths } from '@crewhall/shared';
import { expoStub } from './chat-helpers';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';
import { callTool } from './mcp-helpers';

/** Approval requests reach the phone too: a bell row and a push, not only the e-mail. */
describe('approval requests as notifications', () => {
  let app: TestApp;
  let expo: Awaited<ReturnType<typeof expoStub>>;
  let owner: Client;
  let ownerId: string;
  let conversationId: string;
  let token: string;

  beforeAll(async () => {
    expo = await expoStub();
    app = await createTestApp({ EXPO_PUSH_URL: expo.url });
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const spaceId = (await owner.api.call('listSpaces')).items.find(
      (s) => s.name === 'Milvasoft',
    )!.id;
    conversationId = (
      await owner.api.call('createConversation', {
        body: { type: 'space', spaceId, name: 'Duyurular' },
      })
    ).id;
    await owner.api.call('updateMcpPolicy', {
      body: {
        requestsPerMinute: 600,
        writesPerMinute: 200,
        approvalRules: [
          ...(await owner.api.call('getMcpPolicy')).approvalRules,
          'chat_space_message',
        ],
      },
    });
    token = (
      await owner.api.call('createMcpToken', {
        body: {
          name: 'Claude',
          scopes: ['hub:read', 'chat:send'],
          spaceIds: null,
          expiresInDays: 30,
        },
      })
    ).value;
    await owner.api.call('registerPushDevice', {
      body: { expoToken: 'ExponentPushToken[owner-phone]', platform: 'ios' },
    });
  });

  afterAll(async () => {
    await app?.close();
    await expo.close();
  });

  const request = async (text: string) => {
    const pending = await callTool(app, token, 'send_message', {
      conversation_id: conversationId,
      text,
    });
    expect(pending.data.status).toBe('pending_approval');
    return pending.data.approval_id as string;
  };
  const noticeOf = async (approvalId: string) =>
    (
      await app.deps.db
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.type, 'approval.requested'), eq(notifications.targetId, approvalId)),
        )
    )[0];

  it('puts the request in the bell and on the phone, opening the approval', async () => {
    const before = expo.sent.length;
    const approvalId = await request('Yayın 17:00');
    const row = await noticeOf(approvalId);
    expect(row).toMatchObject({
      userId: ownerId,
      category: 'alert',
      url: paths.accountApproval(approvalId),
      readAt: null,
    });
    const listed = await owner.api.call('listNotifications', { query: {} });
    expect(listed.items.find((n) => n.target.id === approvalId)).toMatchObject({
      type: 'approval.requested',
      source: 'account',
      target: { type: 'approval' },
      data: { client: 'Claude' },
    });
    const push = expo.sent.slice(before).find((m) => m.to === 'ExponentPushToken[owner-phone]');
    expect(push).toMatchObject({ title: 'Claude onayını bekliyor' });
    expect(push?.data).toMatchObject({
      type: 'approval.requested',
      url: paths.accountApproval(approvalId),
    });

    // Deciding (here or on another device) takes it out of the bell.
    await owner.api.call('approveMcpApproval', { params: { approvalId } });
    expect((await noticeOf(approvalId))!.readAt).not.toBeNull();
  });

  it('a rejected request is read too, and the push follows the person’s preferences', async () => {
    const rejected = await request('Yayın iptal');
    await owner.api.call('rejectMcpApproval', { params: { approvalId: rejected }, body: {} });
    expect((await noticeOf(rejected))!.readAt).not.toBeNull();

    await owner.api.call('updateNotificationPrefs', {
      body: { categories: [{ category: 'alert', push: false }] },
    });
    const before = expo.sent.length;
    const quiet = await request('Sessiz istek');
    expect(await noticeOf(quiet)).toMatchObject({ wantsPush: false });
    expect(expo.sent.length).toBe(before);
  });
});
