import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { incomingWebhooks, messages } from '@crewhall/db';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** GitHub, Azure DevOps and Jira into a channel: signatures, event choice, cards, "Ben bakıyorum". */

let app: TestApp;
let owner: Client;
let elif: Client;
let can: Client;
let groupId: string;
let elifId: string;

beforeAll(async () => {
  app = await createTestApp();
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member')).person;
  elifId = (await elif.api.call('me')).user.id;
  can = (await join(app, owner, 'can@milvasoft.com', 'member')).person;
  const canId = (await can.api.call('me')).user.id;
  const group = await owner.api.call('createConversation', {
    body: { type: 'group', userIds: [elifId, canId], name: 'Geliştirme' },
  });
  groupId = group.id;
});

afterAll(async () => {
  await app.close();
});

const post = (url: string, body: string, headers: Record<string, string>) =>
  app.app.request(new URL(url).pathname + new URL(url).search, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

const sign = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const lastCard = async () => {
  const rows = await app.deps.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, groupId));
  return rows.sort((a, b) => b.seq - a.seq)[0]!;
};

describe('GitHub', () => {
  let url: string;
  let secret: string;
  let hookId: string;

  it('creates an integration with a secret shown once and every event chosen', async () => {
    const created = await owner.api.call('createIncomingWebhook', {
      params: { conversationId: groupId },
      body: { name: 'GitHub · crewhall', provider: 'github' },
    });
    url = created.url;
    secret = created.secret!;
    hookId = created.webhook.id;
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect(created.webhook).toMatchObject({ provider: 'github' });
    expect(created.webhook.events).toContain('pull_request');
    const [row] = await app.deps.db
      .select()
      .from(incomingWebhooks)
      .where(eq(incomingWebhooks.id, hookId));
    expect(row!.secretEnc).not.toContain(secret);
    await expect(
      owner.api.call('createIncomingWebhook', {
        params: { conversationId: groupId },
        body: { name: 'x', provider: 'jira', events: ['push'] },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a request without the right signature', async () => {
    const body = JSON.stringify({ zen: 'Keep it simple.' });
    const res = await post(url, body, {
      'x-github-event': 'ping',
      'x-hub-signature-256': sign('yanlış', body),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('webhook_signature_invalid');
  });

  it('posts a merged pull request as a card and drops what the channel does not need', async () => {
    const pr = JSON.stringify({
      action: 'closed',
      repository: { full_name: 'milvasoft/crewhall' },
      sender: { login: 'bugra' },
      pull_request: {
        number: 42,
        title: 'Teşekkür duvarı',
        merged: true,
        html_url: 'https://github.com/milvasoft/crewhall/pull/42',
        user: { login: 'elif' },
        head: { ref: 'feat/kudos' },
        base: { ref: 'master' },
      },
    });
    const res = await post(url, pr, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(secret, pr),
    });
    expect(res.status).toBe(200);
    const msg = await lastCard();
    expect(msg.kind).toBe('webhook');
    const card = msg.body.card as { title: string; severity: string; source: string };
    expect(card).toMatchObject({ severity: 'success', source: 'GitHub' });
    expect(card.title).toContain('#42 Teşekkür duvarı');

    // A new commit on an open PR (synchronize) is not worth a message.
    const sync = JSON.stringify({ action: 'synchronize', pull_request: { number: 42 } });
    const res2 = await post(url, sync, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(secret, sync),
    });
    expect(await res2.json()).toMatchObject({ ignored: true });
    expect((await lastCard()).id).toBe(msg.id);
  });

  it('posts only the chosen events', async () => {
    await owner.api.call('updateIncomingWebhook', {
      params: { webhookId: hookId },
      body: { events: ['workflow_run'] },
    });
    const before = (await lastCard()).id;
    const issue = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'milvasoft/crewhall' },
      issue: { number: 7, title: 'Hata', html_url: 'https://github.com/x/y/issues/7' },
    });
    const res = await post(url, issue, {
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(secret, issue),
    });
    expect(await res.json()).toMatchObject({ ignored: true, event: 'issues' });
    expect((await lastCard()).id).toBe(before);
    await expect(
      owner.api.call('updateIncomingWebhook', {
        params: { webhookId: hookId },
        body: { events: ['jira:issue_created'] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('Jira and Azure DevOps', () => {
  it('checks the Jira signature and words the issue', async () => {
    const created = await owner.api.call('createIncomingWebhook', {
      params: { conversationId: groupId },
      body: { name: 'Jira', provider: 'jira' },
    });
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_created',
      user: { displayName: 'Can' },
      issue: {
        key: 'CRW-12',
        self: 'https://milvasoft.atlassian.net/rest/api/2/issue/10012',
        fields: {
          summary: 'Giriş yavaş',
          status: { name: 'Yapılacak' },
          priority: { name: 'Yüksek' },
        },
      },
    });
    const res = await post(created.url, body, { 'x-hub-signature': sign(created.secret!, body) });
    expect(res.status).toBe(200);
    const card = (await lastCard()).body.card as {
      title: string;
      buttons: { url: string }[];
      fields: { label: string; value: string }[];
    };
    expect(card.title).toContain('CRW-12 Giriş yavaş');
    expect(card.buttons[0]?.url).toBe('https://milvasoft.atlassian.net/browse/CRW-12');
    expect(card.fields).toContainEqual({ label: 'Öncelik', value: 'Yüksek' });
  });

  it('takes the Azure DevOps secret as the Basic auth password', async () => {
    const created = await owner.api.call('createIncomingWebhook', {
      params: { conversationId: groupId },
      body: { name: 'Azure', provider: 'azure_devops', events: ['build.complete'] },
    });
    const body = JSON.stringify({
      eventType: 'build.complete',
      message: { text: 'Build 20261029.3 failed' },
      resource: {
        result: 'failed',
        _links: { web: { href: 'https://dev.azure.com/m/p/_build/3' } },
      },
    });
    const bad = await post(created.url, body, {
      authorization: `Basic ${Buffer.from('crewhall:yanlış').toString('base64')}`,
    });
    expect(bad.status).toBe(401);
    const res = await post(created.url, body, {
      authorization: `Basic ${Buffer.from(`crewhall:${created.secret}`).toString('base64')}`,
    });
    expect(res.status).toBe(200);
    const card = (await lastCard()).body.card as { title: string; severity: string };
    expect(card).toMatchObject({ title: 'Build 20261029.3 failed', severity: 'critical' });
  });
});

describe('Ben bakıyorum', () => {
  it('shows who took a card; only they (or a moderator) let go', async () => {
    const msg = await lastCard();
    const taken = await elif.api.call('claimMessage', { params: { messageId: msg.id } });
    expect(taken.claim?.user.id).toBe(elifId);
    // Can cannot let go of Elif's claim, but may take it over.
    await expect(
      can.api.call('unclaimMessage', { params: { messageId: msg.id } }),
    ).rejects.toMatchObject({ status: 403 });
    const over = await can.api.call('claimMessage', { params: { messageId: msg.id } });
    expect(over.claim?.user.id).not.toBe(elifId);
    const freed = await can.api.call('unclaimMessage', { params: { messageId: msg.id } });
    expect(freed.claim).toBeNull();
    // Ordinary messages cannot be claimed.
    const plain = await owner.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { text: 'merhaba', clientMsgId: crypto.randomUUID() },
    });
    await expect(
      elif.api.call('claimMessage', { params: { messageId: plain.id } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
