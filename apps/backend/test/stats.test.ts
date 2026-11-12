import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@crewhall/api-client';
import { areaOf, countsAsWrite, flushActivity, utcDay } from '../src/services/stats/activity';
import { rollupStats } from '../src/services/stats/rollup';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/**
 * Admin statistics (roadmap 21) against real Postgres: requests are counted per person, day and
 * area; the rollup job fills org_stats_daily; the dashboard reads only the rollup.
 */

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

const DAY = 86_400_000;

describe('admin statistics', () => {
  let app: TestApp;
  let owner: Client;
  let member: Client;
  let orgId: string;
  let ownerId: string;
  let spaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const s = await setupWithOwner(app);
    owner = s.owner;
    orgId = s.orgId;
    ownerId = s.ownerId;
    member = (await join(app, owner, 'can@milvasoft.com', 'member')).person;
    const spaces = await owner.api.call('listSpaces');
    spaceId = spaces.items.find((x) => x.name === 'Altyapı')!.id;
  });
  afterAll(() => app.close());

  it('maps endpoints to areas', () => {
    expect(areaOf('vaultList', '/api/v1/vault/vaults')).toBe('vault');
    expect(areaOf('createFolder', '/api/v1/spaces/:spaceId/nodes')).toBe('core');
    expect(areaOf('getNode', '/api/v1/nodes/:nodeId')).toBe('drive');
    expect(areaOf('listCards', '/api/v1/surfaces/:surfaceId/cards')).toBe('quick');
    expect(areaOf('me', '/api/v1/me')).toBe('core');
  });

  it('does not count automatic seen/opened writes as actions', () => {
    expect(countsAsWrite('sendMessage', 'POST')).toBe(true);
    expect(countsAsWrite('markConversationUnread', 'POST')).toBe(true);
    expect(countsAsWrite('getNode', 'GET')).toBe(false);
    for (const e of [
      'markConversationRead',
      'markAnnouncementRead',
      'markNodeOpened',
      'recordLinkOpen',
      'previewLink',
    ]) {
      expect(countsAsWrite(e, 'POST')).toBe(false);
    }
    // Opening a mail thread marks it seen; starring or marking unread is the person's own act.
    const flags = { folder: 'INBOX', uids: [1] };
    expect(countsAsWrite('mailUpdateFlags', 'POST', { ...flags, seen: true })).toBe(false);
    expect(countsAsWrite('mailUpdateFlags', 'POST', { ...flags, seen: false })).toBe(true);
    expect(countsAsWrite('mailUpdateFlags', 'POST', { ...flags, flagged: true })).toBe(true);
    expect(countsAsWrite('mailUpdateFlags', 'POST', { ...flags, seen: true, flagged: false })).toBe(
      true,
    );
  });

  it('is for owners and admins only', async () => {
    const err = await apiError(member.api.call('adminStats', { query: {} }));
    expect(err.status).toBe(403);
    const anon = await new Client(app).raw('GET', '/api/v1/org/stats');
    expect(anon.status).toBe(401);
  });

  it('counts active people, module use and storage from the rollup', async () => {
    // The member uses the vault and Drive; the owner uploads a file.
    await member.api.call('vaultKeys');
    await member.api.call('listSpaces');
    await uploadFile(owner, {
      spaceId,
      name: 'rapor.pdf',
      content: Buffer.alloc(4096, 7),
      mime: 'application/pdf',
    });
    const stats = await owner.api.call('adminStatsRefresh', { query: { days: 7 } });
    const today = utcDay(new Date());
    expect(stats.days).toBe(7);
    expect(stats.computedAt).not.toBeNull();
    expect(stats.activeUsers).toHaveLength(7);
    expect(stats.activeUsers.at(-1)).toMatchObject({ day: today, dau: 2, wau: 2, mau: 2 });
    expect(stats.totals).toMatchObject({ members: 2, dau: 2, wau: 2, mau: 2 });
    expect(stats.totals.storageBytes).toBeGreaterThanOrEqual(4096);
    expect(stats.storage.at(-1)?.day).toBe(today);

    const vault = stats.modules.find((m) => m.area === 'vault')!;
    expect(vault.peakUsers).toBe(1);
    expect(vault.series.at(-1)?.users).toBe(1);
    const core = stats.modules.find((m) => m.area === 'core')!;
    expect(core.peakUsers).toBe(2);
    expect(core.actions).toBeGreaterThan(0);

    expect(stats.topUsers[0]).toMatchObject({ user: { id: ownerId }, bytes: 4096 });
    const altyapi = stats.growingSpaces.find((g) => g.space.id === spaceId)!;
    expect(altyapi).toMatchObject({ bytes: 4096, items: 1 });
  });

  it('reads the range: growth since the first day measured, zeros on quiet days', async () => {
    const weekAgo = utcDay(new Date(Date.now() - 5 * DAY));
    await app.deps.db.execute(sql`
      insert into org_stats_daily (org_id, day, metric, dim, value)
      values (${orgId}, ${weekAgo}::date, 'space_bytes', ${spaceId}, 0),
             (${orgId}, ${weekAgo}::date, 'space_items', ${spaceId}, 0),
             (${orgId}, ${weekAgo}::date, 'storage_bytes', '', 0)`);
    const stats = await owner.api.call('adminStats', { query: { days: 7 } });
    expect(stats.growingSpaces[0]).toMatchObject({
      space: { id: spaceId, name: 'Altyapı' },
      growthBytes: 4096,
      growthItems: 1,
    });
    expect(stats.storage.map((p) => p.day)).toContain(weekAgo);
    expect(stats.activeUsers.find((p) => p.day === weekAgo)).toMatchObject({ dau: 0 });
  });

  it('windows: yesterday counts in this week but not in today', async () => {
    const yesterday = utcDay(new Date(Date.now() - DAY));
    const [admin] = (
      await app.deps.db.execute<{ id: string }>(
        sql`select id from users where email = 'can@milvasoft.com'`,
      )
    ).rows;
    await app.deps.db.execute(sql`
      insert into activity_daily (org_id, day, user_id, area, requests, writes)
      values (${orgId}, ${yesterday}::date, ${admin!.id}, 'chat', 5, 2)`);
    await flushActivity(app.deps.db);
    await rollupStats(app.deps.db);
    const stats = await owner.api.call('adminStats', { query: { days: 7 } });
    const y = stats.activeUsers.find((p) => p.day === yesterday)!;
    expect(y.dau).toBe(1);
    const chat = stats.modules.find((m) => m.area === 'chat')!;
    expect(chat.actions).toBe(2);
    expect(chat.series.find((p) => p.day === yesterday)?.users).toBe(1);
  });

  it('is idempotent and prunes raw activity past its window', async () => {
    const before = await owner.api.call('adminStats', { query: { days: 30 } });
    await rollupStats(app.deps.db);
    await rollupStats(app.deps.db);
    const after = await owner.api.call('adminStats', { query: { days: 30 } });
    expect(after.activeUsers).toEqual(before.activeUsers);
    expect(after.modules).toEqual(before.modules);

    const old = utcDay(new Date(Date.now() - 70 * DAY));
    await app.deps.db.execute(sql`
      insert into activity_daily (org_id, day, user_id, area, requests, writes)
      values (${orgId}, ${old}::date, ${ownerId}, 'core', 1, 0)`);
    await rollupStats(app.deps.db);
    const left = await app.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from activity_daily where day = ${old}::date`,
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it('leaves switched-off modules out', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { boards: false } } } });
    const stats = await owner.api.call('adminStats', { query: { days: 7 } });
    expect(stats.modules.map((m) => m.area)).not.toContain('boards');
    expect(stats.modules.map((m) => m.area)).toContain('drive');
  });

  it('only accepts the offered ranges', async () => {
    const bad = await owner.raw('GET', '/api/v1/org/stats?days=12');
    expect(bad.status).toBe(422);
  });
});
