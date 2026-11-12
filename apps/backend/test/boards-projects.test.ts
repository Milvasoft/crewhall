import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { boardCards } from '@crewhall/db';
import { daysBetween } from '../src/services/boards/sprints';
import { templateSettings } from '../src/services/boards/templates';
import { mondayOf } from '../src/services/boards/workload';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const DAY = 86_400_000;
const ZONE = 'Europe/Istanbul';
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const addDaysIso = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Project management on boards (kararlar 2026-10-29): sprints first. */
describe('board projects', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let mert: Awaited<ReturnType<typeof join>>;
  let selin: Awaited<ReturnType<typeof join>>;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: mert.me.user.id },
      body: { role: 'editor' },
    });
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: selin.me.user.id },
      body: { role: 'viewer' },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  async function newBoard(name: string, template: 'empty' | 'sprint' = 'empty') {
    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name, template, tz: ZONE },
    });
    return owner.api.call('getBoard', { params: { boardId: board.id } });
  }

  describe('sprints', () => {
    it('plans, starts, burns down and closes a sprint; unfinished cards move on', async () => {
      const detail = await newBoard('Sprint panosu', 'sprint');
      const boardId = detail.board.id;
      // The sprint template starts with an active sprint, mirrored in settings.sprint.
      expect(detail.sprints).toHaveLength(1);
      const first = detail.sprints![0]!;
      expect(first.status).toBe('active');
      expect(detail.board.settings.sprint).toEqual({
        name: first.name,
        startsOn: first.startsOn,
        endsOn: first.endsOn,
      });
      const [todo, , , done] = detail.columns;

      // Cards made on the board join the active sprint; null puts one in the backlog.
      const a = await mert.person.api.call('createBoardCard', {
        params: { boardId },
        body: { columnId: todo!.id, title: 'Giriş ekranı' },
      });
      const b = await mert.person.api.call('createBoardCard', {
        params: { boardId },
        body: { columnId: todo!.id, title: 'Şifre sıfırlama', sprintId: null },
      });
      expect(a.sprintId).toBe(first.id);
      expect(b.sprintId).toBeNull();
      await mert.person.api.call('updateBoardCard', {
        params: { cardId: a.id },
        body: { points: 5 },
      });

      // Planning: a second sprint, the backlog card goes into it.
      const next = await mert.person.api.call('createBoardSprint', {
        params: { boardId },
        body: { name: 'Sprint 2', startsOn: isoDay(14), endsOn: isoDay(27) },
      });
      expect(next.status).toBe('planned');
      const moved = await mert.person.api.call('updateBoardCard', {
        params: { cardId: b.id },
        body: { sprintId: next.id },
      });
      expect(moved.sprintId).toBe(next.id);

      // Viewers cannot plan; editors cannot start or close (manage).
      await expect(
        selin.person.api.call('createBoardSprint', {
          params: { boardId },
          body: { name: 'X', startsOn: isoDay(0), endsOn: isoDay(1) },
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        mert.person.api.call('startBoardSprint', { params: { sprintId: next.id } }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      // Only one sprint is active at a time.
      await expect(
        owner.api.call('startBoardSprint', { params: { sprintId: next.id } }),
      ).rejects.toMatchObject({ code: 'board_sprint_active' });
      // End before start is refused.
      await expect(
        mert.person.api.call('updateBoardSprint', {
          params: { sprintId: next.id },
          body: { endsOn: isoDay(1) },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });

      // Burndown in points: 5 to do, nothing done yet.
      const burn = await mert.person.api.call('getBoardSprintBurndown', {
        params: { sprintId: first.id },
        query: { tz: ZONE },
      });
      expect(burn.unit).toBe('points');
      expect(burn.days).toHaveLength(14);
      expect(burn.days[0]).toMatchObject({ remaining: 5, ideal: 5 });
      expect(burn.days.at(-1)).toMatchObject({ remaining: null, ideal: 0 });
      expect(burn).toMatchObject({ total: 5, done: 0 });

      // One more card, done; then close: the open card moves to Sprint 2.
      const c = await mert.person.api.call('createBoardCard', {
        params: { boardId },
        body: { columnId: done!.id, title: 'Logo' },
      });
      await mert.person.api.call('updateBoardCard', {
        params: { cardId: c.id },
        body: { points: 3 },
      });
      const after = await mert.person.api.call('getBoardSprintBurndown', {
        params: { sprintId: first.id },
      });
      expect(after).toMatchObject({ total: 8, done: 3 });

      const closed = await owner.api.call('closeBoardSprint', {
        params: { sprintId: first.id },
        body: { moveTo: next.id },
      });
      expect(closed.moved).toBe(1);
      expect(closed.sprint).toMatchObject({
        status: 'closed',
        result: { unit: 'points', done: 3, total: 8 },
      });
      const card = await mert.person.api.call('getBoardCard', { params: { cardId: a.id } });
      expect(card.sprintId).toBe(next.id);
      const board = await mert.person.api.call('getBoard', { params: { boardId } });
      expect(board.board.settings.sprint).toBeNull();
      expect(board.sprints!.map((s) => s.id)).toEqual([next.id]);

      // A closed sprint takes no cards; a planned one can be started now.
      await expect(
        mert.person.api.call('updateBoardCard', {
          params: { cardId: a.id },
          body: { sprintId: first.id },
        }),
      ).rejects.toMatchObject({ code: 'invalid_target' });
      const started = await owner.api.call('startBoardSprint', { params: { sprintId: next.id } });
      expect(started.status).toBe('active');
      const all = await mert.person.api.call('listBoardSprints', { params: { boardId } });
      expect(all.items.map((s) => s.status)).toEqual(['closed', 'active']);
    });

    describe("the template's first sprint starts on the creator's today", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /** 01:30 in Istanbul (UTC+3 all year), UTC still on the day before; near the real clock so sessions stay valid. */
      function atNightInIstanbul() {
        const night = new Date();
        night.setUTCHours(22, 30, 0, 0);
        vi.useFakeTimers({ toFake: ['Date'], now: night });
        return {
          utcToday: night.toISOString().slice(0, 10),
          localToday: addDaysIso(night.toISOString().slice(0, 10), 1),
        };
      }

      it('counts cards made after local midnight in day 0', async () => {
        const { localToday } = atNightInIstanbul();
        const detail = await newBoard('Gece sprinti', 'sprint');
        const sprint = detail.sprints![0]!;
        expect(sprint.startsOn).toBe(localToday);
        expect(sprint.endsOn).toBe(addDaysIso(localToday, 13));

        const card = await mert.person.api.call('createBoardCard', {
          params: { boardId: detail.board.id },
          body: { columnId: detail.columns[0]!.id, title: 'Gece işi' },
        });
        await mert.person.api.call('updateBoardCard', {
          params: { cardId: card.id },
          body: { points: 5 },
        });
        const burn = await mert.person.api.call('getBoardSprintBurndown', {
          params: { sprintId: sprint.id },
          query: { tz: ZONE },
        });
        expect(burn.days).toHaveLength(14);
        expect(burn.days[0]).toMatchObject({ date: localToday, remaining: 5, ideal: 5 });
        expect(burn).toMatchObject({ total: 5, done: 0 });
      });

      it("uses the person's saved zone when the client sends none", async () => {
        const { localToday, utcToday } = atNightInIstanbul();
        const create = async (client: Client, name: string) => {
          const board = await client.api.call('createBoard', {
            params: { spaceId },
            body: { name, template: 'sprint' },
          });
          const detail = await client.api.call('getBoard', { params: { boardId: board.id } });
          return detail.sprints![0]!.startsOn;
        };
        // Nothing saved: UTC.
        expect(await create(mert.person, 'Bölgesiz sprint')).toBe(utcToday);
        await mert.person.api.call('updateCalendarSettings', { body: { timeZone: ZONE } });
        expect(await create(mert.person, 'Bölgeli sprint')).toBe(localToday);
      });

      it.each([
        ['Europe/Istanbul', '2026-11-04T23:58:00Z', '2026-11-05', '2026-11-18'],
        ['America/New_York', '2026-11-05T02:00:00Z', '2026-11-04', '2026-11-17'],
        // Over the end of summer time, still 14 calendar days.
        ['Europe/Berlin', '2026-10-20T22:30:00Z', '2026-10-21', '2026-11-03'],
        [undefined, '2026-11-04T23:58:00Z', '2026-11-04', '2026-11-17'],
        ['Mars/Olympus', '2026-11-04T23:58:00Z', '2026-11-04', '2026-11-17'],
      ])('in %s at %s', (timeZone, at, startsOn, endsOn) => {
        const { sprint } = templateSettings(
          'sprint',
          'tr',
          { key: 'KRT', cardChats: true, ...(timeZone ? { timeZone } : {}) },
          new Date(at),
        );
        expect(sprint).toMatchObject({ startsOn, endsOn });
        expect(daysBetween(startsOn, endsOn)).toHaveLength(14);
      });
    });

    it('keeps settings.sprint working for clients from before sprints', async () => {
      const detail = await newBoard('Eski istemci');
      const boardId = detail.board.id;
      const card = await owner.api.call('createBoardCard', {
        params: { boardId },
        body: { columnId: detail.columns[0]!.id, title: 'Var olan iş' },
      });
      expect(card.sprintId).toBeNull();
      const sprint = { name: 'Sprint 7', startsOn: isoDay(0), endsOn: isoDay(9) };
      const board = await owner.api.call('updateBoard', { params: { boardId }, body: { sprint } });
      expect(board.settings.sprint).toEqual(sprint);
      // The new sprint covers the cards the band used to count.
      const again = await owner.api.call('getBoard', { params: { boardId } });
      expect(again.sprints).toHaveLength(1);
      expect(again.cards[0]!.sprintId).toBe(again.sprints![0]!.id);
      // Turning the band off closes the sprint; open cards go back to the backlog.
      const off = await owner.api.call('updateBoard', {
        params: { boardId },
        body: { sprint: null },
      });
      expect(off.settings.sprint).toBeNull();
      const [row] = await app.deps.db.select().from(boardCards).where(eq(boardCards.id, card.id));
      expect(row!.sprintId).toBeNull();
    });

    it('deletes only planned sprints and bulk-plans cards', async () => {
      const detail = await newBoard('Toplu planlama');
      const boardId = detail.board.id;
      const col = detail.columns[0]!.id;
      const ids: string[] = [];
      for (const title of ['Bir', 'İki', 'Üç']) {
        ids.push(
          (
            await mert.person.api.call('createBoardCard', {
              params: { boardId },
              body: { columnId: col, title },
            })
          ).id,
        );
      }
      const s = await mert.person.api.call('createBoardSprint', {
        params: { boardId },
        body: { name: 'Plan', goal: 'Girişi bitir', startsOn: isoDay(0), endsOn: isoDay(6) },
      });
      expect(s.goal).toBe('Girişi bitir');
      await mert.person.api.call('bulkUpdateBoardCards', {
        params: { boardId },
        body: { cardIds: ids, sprintId: s.id },
      });
      const [listed] = (await mert.person.api.call('listBoardSprints', { params: { boardId } }))
        .items;
      expect(listed!.cardCount).toBe(3);
      // Burndown in cards when the board has no points.
      const burn = await mert.person.api.call('getBoardSprintBurndown', {
        params: { sprintId: s.id },
      });
      expect(burn).toMatchObject({ unit: 'cards', total: 3, done: 0 });

      await mert.person.api.call('deleteBoardSprint', { params: { sprintId: s.id } });
      const back = await mert.person.api.call('getBoard', { params: { boardId } });
      expect(back.cards.every((c) => c.sprintId === null)).toBe(true);
      expect(back.sprints).toEqual([]);
    });

    it('counts calendar days inclusively', () => {
      expect(daysBetween('2026-10-30', '2026-11-02')).toEqual([
        '2026-10-30',
        '2026-10-31',
        '2026-11-01',
        '2026-11-02',
      ]);
    });
  });
  describe('dependencies', () => {
    it('links cards across boards, flags blocked cards and refuses loops', async () => {
      const a = await newBoard('Bağımlılık A');
      const col = a.columns[0]!.id;
      const make = async (boardId: string, columnId: string, title: string) =>
        mert.person.api.call('createBoardCard', {
          params: { boardId },
          body: { columnId, title },
        });
      const api1 = await make(a.board.id, col, 'API ucu');
      const web1 = await make(a.board.id, col, 'Web ekranı');
      const doc1 = await make(a.board.id, col, 'Doküman');
      // A board in a space Mert cannot see.
      const secret = await owner.api.call('createSpace', { body: { name: 'Gizli', color: 's5' } });
      const hidden = await owner.api.call('createBoard', {
        params: { spaceId: secret.id },
        body: { name: 'Gizli pano' },
      });
      const hiddenCols = await owner.api.call('getBoard', { params: { boardId: hidden.id } });
      const h1 = await owner.api.call('createBoardCard', {
        params: { boardId: hidden.id },
        body: { columnId: hiddenCols.columns[0]!.id, title: 'Gizli iş' },
      });

      // API blocks Web; read from both ends.
      const out = await mert.person.api.call('addBoardCardLink', {
        params: { cardId: api1.id },
        body: { cardId: web1.id, type: 'blocks' },
      });
      expect(out.items).toMatchObject([{ type: 'blocks', card: { id: web1.id } }]);
      const webLinks = await mert.person.api.call('listBoardCardLinks', {
        params: { cardId: web1.id },
      });
      expect(webLinks.items).toMatchObject([
        { type: 'blocked_by', card: { id: api1.id, done: false } },
      ]);
      // Docs relate to Web (once, whichever way it is added).
      await mert.person.api.call('addBoardCardLink', {
        params: { cardId: doc1.id },
        body: { cardId: web1.id, type: 'relates' },
      });
      await mert.person.api.call('addBoardCardLink', {
        params: { cardId: web1.id },
        body: { cardId: doc1.id, type: 'relates' },
      });
      const detail = await mert.person.api.call('getBoardCard', { params: { cardId: web1.id } });
      expect(detail.links!.map((l) => l.type)).toEqual(['blocked_by', 'relates']);
      expect(detail.blockedBy).toBe(1);

      // Doc blocks API, API blocks Web: Web blocking Doc would loop.
      await mert.person.api.call('addBoardCardLink', {
        params: { cardId: api1.id },
        body: { cardId: doc1.id, type: 'blocked_by' },
      });
      await expect(
        mert.person.api.call('addBoardCardLink', {
          params: { cardId: web1.id },
          body: { cardId: doc1.id, type: 'blocks' },
        }),
      ).rejects.toMatchObject({ code: 'board_link_cycle' });
      await expect(
        mert.person.api.call('addBoardCardLink', {
          params: { cardId: web1.id },
          body: { cardId: web1.id, type: 'relates' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_target' });
      // Viewers cannot link; nobody links to a card they cannot see.
      await expect(
        selin.person.api.call('addBoardCardLink', {
          params: { cardId: web1.id },
          body: { cardId: doc1.id, type: 'relates' },
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        mert.person.api.call('addBoardCardLink', {
          params: { cardId: web1.id },
          body: { cardId: h1.id, type: 'blocked_by' },
        }),
      ).rejects.toMatchObject({ status: 404 });

      // The owner links the hidden card; Mert does not see that line.
      await owner.api.call('addBoardCardLink', {
        params: { cardId: h1.id },
        body: { cardId: web1.id, type: 'blocks' },
      });
      const seen = await mert.person.api.call('listBoardCardLinks', {
        params: { cardId: web1.id },
      });
      expect(seen.items.map((l) => l.card.id)).not.toContain(h1.id);
      const all = await owner.api.call('listBoardCardLinks', { params: { cardId: web1.id } });
      expect(all.items.map((l) => l.card.id)).toContain(h1.id);

      // The board carries its own blocks links for the timeline and the badge counts.
      const board = await mert.person.api.call('getBoard', { params: { boardId: a.board.id } });
      expect(board.dependencies).toEqual(
        expect.arrayContaining([
          { fromId: api1.id, toId: web1.id },
          { fromId: doc1.id, toId: api1.id },
        ]),
      );
      expect(board.dependencies).toHaveLength(2);
      expect(board.cards.find((c) => c.id === web1.id)!.blockedBy).toBe(2);

      // Done blockers no longer count; removing a link drops it from both ends.
      const doneCol = a.columns.find((c) => c.isDone)!;
      await mert.person.api.call('moveBoardCard', {
        params: { cardId: api1.id },
        body: { columnId: doneCol.id, afterId: null, beforeId: null },
      });
      const after = await mert.person.api.call('getBoardCard', { params: { cardId: web1.id } });
      expect(after.blockedBy).toBe(1);
      const relates = after.links!.find((l) => l.type === 'relates')!;
      await mert.person.api.call('removeBoardCardLink', { params: { linkId: relates.id } });
      const docAfter = await mert.person.api.call('listBoardCardLinks', {
        params: { cardId: doc1.id },
      });
      expect(docAfter.items.map((l) => l.type)).toEqual(['blocks']);
    });

    it('finds cards to link by title words or key, only where the caller can see', async () => {
      const a = await newBoard('Arama panosu');
      const card = await mert.person.api.call('createBoardCard', {
        params: { boardId: a.board.id },
        body: { columnId: a.columns[0]!.id, title: 'Ödeme sağlayıcı entegrasyonu' },
      });
      const byWords = await mert.person.api.call('searchBoardCards', {
        query: { q: 'ödeme entegr', boardId: a.board.id },
      });
      expect(byWords.items[0]).toMatchObject({ id: card.id, boardName: 'Arama panosu' });
      const key = byWords.items[0]!.key;
      const byKey = await mert.person.api.call('searchBoardCards', { query: { q: key } });
      expect(byKey.items.map((c) => c.id)).toContain(card.id);
      const hidden = await mert.person.api.call('searchBoardCards', { query: { q: 'Gizli iş' } });
      expect(hidden.items).toEqual([]);
    });
  });
  describe('timeline', () => {
    it('keeps a start date before the due date', async () => {
      const b = await newBoard('Zaman çizelgesi');
      const start = new Date(Date.now() + 2 * DAY).toISOString();
      const due = new Date(Date.now() + 6 * DAY).toISOString();
      const card = await mert.person.api.call('createBoardCard', {
        params: { boardId: b.board.id },
        body: { columnId: b.columns[0]!.id, title: 'Tasarım', startAt: start, dueAt: due },
      });
      expect(card).toMatchObject({ startAt: start, dueAt: due });
      // Moving both keeps them valid; a start after the due date is refused.
      const later = new Date(Date.now() + 9 * DAY).toISOString();
      await expect(
        mert.person.api.call('updateBoardCard', {
          params: { cardId: card.id },
          body: { startAt: later },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      const moved = await mert.person.api.call('updateBoardCard', {
        params: { cardId: card.id },
        body: { startAt: later, dueAt: new Date(Date.now() + 12 * DAY).toISOString() },
      });
      expect(moved.startAt).toBe(later);
      await expect(
        mert.person.api.call('createBoardCard', {
          params: { boardId: b.board.id },
          body: { columnId: b.columns[0]!.id, title: 'Ters', startAt: due, dueAt: start },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      const cleared = await mert.person.api.call('updateBoardCard', {
        params: { cardId: card.id },
        body: { startAt: null },
      });
      expect(cleared.startAt).toBeNull();
    });
  });
  describe('time tracking', () => {
    it('runs one timer per person, logs by hand and keeps edits to the owner or managers', async () => {
      const b = await newBoard('Zaman takibi');
      const col = b.columns[0]!.id;
      const one = await mert.person.api.call('createBoardCard', {
        params: { boardId: b.board.id },
        body: { columnId: col, title: 'Rapor ekranı' },
      });
      const two = await mert.person.api.call('createBoardCard', {
        params: { boardId: b.board.id },
        body: { columnId: col, title: 'Dışa aktarma' },
      });
      await mert.person.api.call('updateBoardCard', {
        params: { cardId: one.id },
        body: { estimateMinutes: 240 },
      });

      // A timer on one card; starting another stops it.
      const first = await mert.person.api.call('startBoardCardTimer', {
        params: { cardId: one.id },
      });
      expect(first).toMatchObject({ minutes: null, source: 'timer', canEdit: true });
      const mine = await mert.person.api.call('getMyBoardTimer');
      expect(mine.entry).toMatchObject({
        id: first.id,
        card: { id: one.id, title: 'Rapor ekranı' },
      });
      await mert.person.api.call('startBoardCardTimer', { params: { cardId: two.id } });
      const oneTime = await mert.person.api.call('listBoardCardTime', {
        params: { cardId: one.id },
      });
      expect(oneTime.items[0]).toMatchObject({ id: first.id, minutes: 1 });
      const stopped = await mert.person.api.call('stopMyBoardTimer');
      expect(stopped.entry).toMatchObject({ cardId: two.id, minutes: 1 });
      expect((await mert.person.api.call('stopMyBoardTimer')).entry).toBeNull();
      expect((await mert.person.api.call('getMyBoardTimer')).entry).toBeNull();

      // By hand, with a note; the card sums the finished entries.
      const typed = await mert.person.api.call('addBoardCardTime', {
        params: { cardId: one.id },
        body: { minutes: 90, note: 'Tasarım incelemesi' },
      });
      const card = await mert.person.api.call('getBoardCard', { params: { cardId: one.id } });
      expect(card).toMatchObject({ estimateMinutes: 240, spentMinutes: 91 });

      // Viewers read but do not log; others' entries are the owner's or a manager's.
      await expect(
        selin.person.api.call('addBoardCardTime', {
          params: { cardId: one.id },
          body: { minutes: 10 },
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(
        (await selin.person.api.call('listBoardCardTime', { params: { cardId: one.id } })).items,
      ).toHaveLength(2);
      const ownerView = await owner.api.call('listBoardCardTime', { params: { cardId: one.id } });
      expect(ownerView.items.every((e) => e.canEdit)).toBe(true);
      const edited = await owner.api.call('updateBoardTimeEntry', {
        params: { entryId: typed.id },
        body: { minutes: 120 },
      });
      expect(edited.minutes).toBe(120);
      await expect(
        mert.person.api.call('addBoardCardTime', {
          params: { cardId: one.id },
          body: { minutes: 24 * 60 + 1 },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      // A running timer's minutes come from stopping it.
      const running = await mert.person.api.call('startBoardCardTimer', {
        params: { cardId: one.id },
      });
      await expect(
        mert.person.api.call('updateBoardTimeEntry', {
          params: { entryId: running.id },
          body: { minutes: 5 },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await mert.person.api.call('deleteBoardTimeEntry', { params: { entryId: running.id } });
      const after = await mert.person.api.call('getBoardCard', { params: { cardId: one.id } });
      expect(after.spentMinutes).toBe(121);
    });
  });
  describe('workload', () => {
    it('spreads estimates over weeks and assignees, counts unestimated and undated cards', async () => {
      const b = await newBoard('İş yükü');
      const boardId = b.board.id;
      const col = b.columns[0]!.id;
      const mertId = mert.me.user.id;
      const ownerId = (await owner.api.call('me')).user.id;
      const monday = mondayOf(isoDay(0));
      const at = (day: string, hour: number) =>
        `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
      const make = async (title: string, body: Record<string, unknown>) => {
        const c = await mert.person.api.call('createBoardCard', {
          params: { boardId },
          body: { columnId: col, title, ...body },
        });
        return c;
      };
      // Ten days from this Monday: 20 hours, half to each of two people.
      const wide = await make('Geniş iş', {
        assigneeIds: [mertId, ownerId],
        startAt: at(monday, 9),
        dueAt: at(addDaysIso(monday, 9), 17),
      });
      await mert.person.api.call('updateBoardCard', {
        params: { cardId: wide.id },
        body: { estimateMinutes: 20 * 60 },
      });
      // Due next week, no estimate.
      const loose = await make('Tahminsiz', {
        assigneeIds: [mertId],
        dueAt: at(addDaysIso(monday, 8), 17),
      });
      // No dates, no sprint.
      const floating = await make('Tarihsiz', { assigneeIds: [mertId] });
      await mert.person.api.call('updateBoardCard', {
        params: { cardId: floating.id },
        body: { estimateMinutes: 90 },
      });
      // Nobody on it: not counted.
      await make('Sahipsiz', { dueAt: at(monday, 17) });

      const w = await mert.person.api.call('getBoardWorkload', {
        params: { boardId },
        query: { from: isoDay(0), weeks: 2, tz: 'UTC' },
      });
      expect(w.weeks).toEqual([monday, addDaysIso(monday, 7)]);
      expect(w.capacityHours).toBe(40);
      const row = (id: string) => w.people.find((p) => p.user.id === id)!;
      // 7 of 10 days in week one, 3 in week two; each person gets half.
      expect(row(mertId).cells.map((c) => c.hours)).toEqual([7, 3]);
      expect(row(ownerId).cells.map((c) => c.hours)).toEqual([7, 3]);
      expect(row(mertId).cells[1]).toMatchObject({ unestimated: 1 });
      expect(row(mertId).cells[1]!.cardIds).toEqual(expect.arrayContaining([wide.id, loose.id]));
      expect(row(mertId).undated).toMatchObject({ hours: 1.5, cardIds: [floating.id] });
      expect(w.cards.map((c) => c.title).sort()).toEqual(['Geniş iş', 'Tahminsiz', 'Tarihsiz']);
      // Selin is on the board but has nothing: an empty row to plan with.
      expect(row(selin.me.user.id).cells.map((c) => c.hours)).toEqual([0, 0]);

      // The board's capacity; done cards drop out.
      await owner.api.call('updateBoard', { params: { boardId }, body: { capacityHours: 30 } });
      const done = b.columns.find((c) => c.isDone)!;
      await mert.person.api.call('moveBoardCard', {
        params: { cardId: wide.id },
        body: { columnId: done.id, afterId: null, beforeId: null },
      });
      const after = await mert.person.api.call('getBoardWorkload', {
        params: { boardId },
        query: { from: isoDay(0), weeks: 2, tz: 'UTC' },
      });
      expect(after.capacityHours).toBe(30);
      expect(after.people.find((p) => p.user.id === mertId)!.cells.map((c) => c.hours)).toEqual([
        0, 0,
      ]);

      // The space view sums every board of the space.
      const space = await mert.person.api.call('getSpaceBoardWorkload', {
        params: { spaceId },
        query: { from: isoDay(0), weeks: 2, tz: 'UTC' },
      });
      expect(space.capacityHours).toBe(40);
      expect(space.cards.map((c) => c.id)).toEqual(expect.arrayContaining([loose.id, floating.id]));
    });
  });
});
