import { strFromU8, unzipSync } from 'fflate';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, heldMessages, messages, nodes } from '@crewhall/db';
import type { CompliancePolicy, DlpRule } from '@crewhall/shared';
import { purgeTrash } from '../src/jobs/handlers';
import { createLogger } from '../src/logger';
import {
  applyRetention,
  BUILT_IN_RULES,
  detects,
  forgetCompliancePolicy,
} from '../src/services/compliance/policy';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const DAY = 86_400_000;
const rule = (detector: DlpRule['detector'], pattern?: string): DlpRule => ({
  id: detector,
  detector,
  name: detector,
  enabled: true,
  action: 'warn',
  ...(pattern ? { pattern } : {}),
});

describe('DLP detectors', () => {
  it('finds card numbers, TC kimlik numbers and IBANs by their checksums', () => {
    expect(detects(rule('card'), 'Kart: 4111 1111 1111 1111, son kullanma 12/29')).toBe(true);
    expect(detects(rule('card'), 'Sipariş no 4111 1111 1111 1112')).toBe(false);
    expect(detects(rule('tckn'), 'TC 10000000146 ile başvurdu')).toBe(true);
    expect(detects(rule('tckn'), 'Telefon 05321234567')).toBe(false);
    expect(detects(rule('iban'), 'IBAN: TR33 0006 1005 1978 6457 8413 26')).toBe(true);
    expect(detects(rule('iban'), 'TR33 0006 1005 1978 6457 8413 27')).toBe(false);
    expect(detects(rule('custom', 'gizli\\s+proje'), 'Bu GİZLİ  proje hakkında')).toBe(true);
  });
});

/**
 * Corporate compliance (roadmap 25): DLP rules on chat, cards and comments; legal holds that
 * keep content through every purge; retention rules; eDiscovery archives.
 */
describe('compliance', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let spaceId: string;
  let mert: Client;
  let mertId: string;
  let directId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
    const m = await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId]);
    mert = m.person;
    mertId = m.me.user.id;
    directId = (
      await owner.api.call('createConversation', { body: { type: 'direct', userId: mertId } })
    ).id;
  });
  afterAll(() => app.close());

  const send = (c: Client, text: string, dlpAck?: boolean) =>
    c.api.call('sendMessage', {
      params: { conversationId: directId },
      body: { clientMsgId: randomUUID(), text, ...(dlpAck ? { dlpAck } : {}) },
    });
  const policy = (patch: Partial<CompliancePolicy>) =>
    owner.api
      .call('getCompliance')
      .then((v) => owner.api.call('updateCompliancePolicy', { body: { ...v.policy, ...patch } }));

  it('lists the built-in DLP rules switched off and keeps everything by default', async () => {
    const view = await owner.api.call('getCompliance');
    expect(view.policy.retention).toEqual({ chatDays: null, auditDays: null });
    expect(view.policy.dlp.rules.map((r) => [r.id, r.enabled])).toEqual(
      BUILT_IN_RULES.map((r) => [r.id, false]),
    );
    await expect(mert.api.call('getCompliance')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('warns once on chat, blocks on "block" rules and records every match', async () => {
    await policy({
      dlp: {
        rules: [
          { ...BUILT_IN_RULES[0]!, enabled: true, action: 'warn' },
          { ...BUILT_IN_RULES[1]!, enabled: true, action: 'block' },
          {
            id: 'kod',
            detector: 'custom',
            pattern: '[',
            name: 'Bozuk',
            enabled: true,
            action: 'warn',
          },
        ],
      },
    }).then(
      () => {
        throw new Error('invalid pattern was accepted');
      },
      (e: { code: string }) => expect(e.code).toBe('validation_failed'),
    );
    await policy({
      dlp: {
        rules: [
          { ...BUILT_IN_RULES[0]!, enabled: true, action: 'warn' },
          { ...BUILT_IN_RULES[1]!, enabled: true, action: 'block' },
        ],
      },
    });
    const card = 'Kartım 4111 1111 1111 1111';
    await expect(send(mert, card)).rejects.toMatchObject({ code: 'dlp_warning', status: 409 });
    await expect(send(mert, card, true)).resolves.toMatchObject({ text: card });
    await expect(send(mert, 'TC: 10000000146')).rejects.toMatchObject({ code: 'dlp_blocked' });

    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Pano' },
    });
    const detail = await owner.api.call('getBoard', { params: { boardId: board.id } });
    await expect(
      owner.api.call('createBoardCard', {
        params: { boardId: board.id },
        body: { columnId: detail.columns[0]!.id, title: 'Müşteri 10000000146' } as never,
      }),
    ).rejects.toMatchObject({ code: 'dlp_blocked' });

    const audits = await app.deps.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.orgId, orgId));
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'compliance.dlp.warned',
        'compliance.dlp.sent',
        'compliance.dlp.blocked',
      ]),
    );
    // The text itself never lands in the audit log.
    const metas = await app.deps.db.select({ meta: auditLogs.meta }).from(auditLogs);
    expect(JSON.stringify(metas)).not.toContain('4111');
    await policy({ dlp: { rules: BUILT_IN_RULES } });
  });

  it('holds a space through trash purges until the hold is released', async () => {
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Dava dosyası' },
    });
    await owner.api.call('trashNodes', { body: { nodeIds: [folder.id] } });
    await app.deps.db
      .update(nodes)
      .set({ deletedAt: new Date(Date.now() - 40 * DAY) })
      .where(eq(nodes.id, folder.id));
    const hold = await owner.api.call('createLegalHold', {
      body: { name: 'Dava 2026/14', reason: 'Mahkeme kararı', spaceIds: [spaceId] },
    });
    expect(hold.spaces.map((s) => s.id)).toEqual([spaceId]);

    await purgeTrash(app.deps);
    const exists = async () =>
      (await app.deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, folder.id)))
        .length;
    expect(await exists()).toBe(1);
    await expect(
      owner.api.call('purgeNodes', { body: { nodeIds: [folder.id] } }),
    ).rejects.toMatchObject({ code: 'legal_hold' });
    await owner.api.call('emptyTrash', { params: { spaceId } });
    expect(await exists()).toBe(1);

    const released = await owner.api.call('releaseLegalHold', { params: { holdId: hold.id } });
    expect(released.releasedAt).not.toBeNull();
    await purgeTrash(app.deps);
    expect(await exists()).toBe(0);
  });

  it("keeps held people's original messages and exempts them from chat retention", async () => {
    const hold = await owner.api.call('createLegalHold', {
      body: { name: 'Mert inceleme', userIds: [mertId] },
    });
    const msg = await send(mert, 'İlk hâli');
    await mert.api.call('updateMessage', {
      params: { messageId: msg.id },
      body: { text: 'Düzeltilmiş hâli' },
    });
    await mert.api.call('deleteMessage', { params: { messageId: msg.id } });
    const originals = await app.deps.db
      .select()
      .from(heldMessages)
      .where(eq(heldMessages.messageId, msg.id));
    expect(originals.map((o) => [o.kind, o.text])).toEqual([
      ['edit', 'İlk hâli'],
      ['delete', 'Düzeltilmiş hâli'],
    ]);

    // Retention: 30 days; Mert's old message stays, the owner's goes.
    const mine = await send(owner, 'Eski bir not');
    const his = await send(mert, 'Eski bir cevap');
    await app.deps.db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 40 * DAY) })
      .where(and(eq(messages.conversationId, directId)));
    await policy({ retention: { chatDays: 30, auditDays: null } });
    forgetCompliancePolicy();
    await applyRetention({ db: app.deps.db, logger: createLogger('silent') });
    const text = async (id: string) =>
      (await app.deps.db.select({ t: messages.text }).from(messages).where(eq(messages.id, id)))[0]!
        .t;
    expect(await text(mine.id)).toBe('');
    expect(await text(his.id)).toBe('Eski bir cevap');
    await owner.api.call('releaseLegalHold', { params: { holdId: hold.id } });
    await policy({ retention: { chatDays: null, auditDays: null } });
  });

  it('builds an eDiscovery archive of a custodian', async () => {
    await send(mert, 'Teklif ekte');
    const exp = await owner.api.call('createEdiscoveryExport', {
      body: {
        name: 'Mert yazışmaları',
        scope: { userIds: [mertId], include: ['chat', 'audit'] } as never,
      },
    });
    const view = await owner.api.call('getCompliance');
    const ready = view.exports.find((e) => e.id === exp.id)!;
    expect(ready.status, ready.error ?? '').toBe('ready');
    expect(ready.counts?.chatMessages).toBeGreaterThan(0);

    const link = await owner.api.call('getEdiscoveryDownload', { params: { exportId: exp.id } });
    const zip = unzipSync(new Uint8Array(await (await fetch(link.url)).arrayBuffer()));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['manifest.json', 'audit.jsonl']));
    const chat = Object.entries(zip)
      .filter(([name]) => name.startsWith('chat/direct-'))
      .map(([, data]) => strFromU8(data))
      .join('');
    expect(chat).toContain('Teklif ekte');
    expect(strFromU8(zip['chat/held-originals.jsonl']!)).toContain('İlk hâli');
    await expect(
      mert.api.call('getEdiscoveryDownload', { params: { exportId: exp.id } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
