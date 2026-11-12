import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardCardDetail, BoardDetail, BoardLabel } from '@crewhall/shared';
import type { CrewhallPort } from '../src/crewhall';
import { COPY_MARK, Engine } from '../src/engine';
import { memoryStore, type Store } from '../src/store';
import {
  ProviderError,
  type Connection,
  type ExternalComment,
  type ExternalItem,
  type FieldsPatch,
  type Installation,
  type Link,
  type LogEntry,
  type ProjectMeta,
  type Provider,
  type Scope,
  type Sync,
} from '../src/types';

const BOARD = '11111111-1111-4111-8111-111111111111';
const TODO = 'col-todo';
const DOING = 'col-doing';
const DONE = 'col-done';
const ali = { id: 'u-ali', name: 'Ali', email: 'ali@x.dev', imageUrl: null };
const ayse = { id: 'u-ayse', name: 'Ayşe', email: 'ayse@x.dev', imageUrl: null };

let clock = Date.parse('2026-11-10T10:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

class FakeProvider implements Provider {
  readonly kind = 'azure' as const;
  items = new Map<string, ExternalItem>();
  comments = new Map<string, ExternalComment[]>();
  updates: FieldsPatch[] = [];
  seq = 100;
  failNext: ProviderError | null = null;

  add(id: string, over: Partial<ExternalItem['fields']> = {}) {
    const item: ExternalItem = {
      id,
      key: `#${id}`,
      url: `https://ado/${id}`,
      type: 'Task',
      project: 'P',
      updatedAt: tick(),
      commentCount: 0,
      removed: false,
      fields: {
        title: `Item ${id}`,
        description: 'desc',
        status: 'New',
        assignee: null,
        priority: 'p2',
        dueDate: null,
        startDate: undefined,
        labels: [],
        points: null,
        ...over,
      },
    };
    this.items.set(id, item);
    return item;
  }
  edit(id: string, over: Partial<ExternalItem['fields']>) {
    const item = this.items.get(id)!;
    item.fields = { ...item.fields, ...over };
    item.updatedAt = tick();
  }
  whoami = async () => ({ name: 'x', email: null });
  listProjects = async () => [];
  projectMeta = async (): Promise<ProjectMeta> => ({
    types: ['Task'],
    statuses: [
      { name: 'New', category: 'todo', types: ['Task'] },
      { name: 'Active', category: 'doing', types: ['Task'] },
      { name: 'Closed', category: 'done', types: ['Task'] },
    ],
  });
  async changedSince(_s: Scope, since: string | null) {
    return [...this.items.values()].filter((i) => !since || i.updatedAt >= since);
  }
  async getItem(id: string) {
    return this.items.get(id) ?? null;
  }
  async createItem(_s: Scope, type: string, fields: FieldsPatch) {
    const id = String(this.seq++);
    const item = this.add(id, { ...(fields as ExternalItem['fields']) });
    item.type = type;
    return item;
  }
  async updateItem(item: ExternalItem, patch: FieldsPatch) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.updates.push(patch);
    this.edit(item.id, patch as Partial<ExternalItem['fields']>);
    return this.items.get(item.id)!;
  }
  async listComments(item: ExternalItem) {
    return this.comments.get(item.id) ?? [];
  }
  async addComment(item: ExternalItem, text: string) {
    const list = this.comments.get(item.id) ?? [];
    const id = String(this.seq++);
    list.push({ id, author: 'bot', text, createdAt: tick() });
    this.comments.set(item.id, list);
    item.commentCount = list.length;
    item.updatedAt = tick();
    return id;
  }
  assignedToMe = async () => [];
  search = async () => [];
  createWebhook = async () => null;
  removeWebhook = async () => undefined;
  webhookItems = () => [];
}

class FakeCrewhall implements CrewhallPort {
  cards = new Map<string, BoardCardDetail>();
  activity = new Map<string, { id: string; text: string; author: string; createdAt: string }[]>();
  labels: BoardLabel[] = [{ id: 'bug', name: 'Bug', color: 's1' }];
  seq = 1;
  writes = 0;
  gone = new Set<string>();
  canManage = true;

  private touch(c: BoardCardDetail) {
    c.updatedAt = tick();
    this.writes++;
  }
  edit(id: string, patch: Partial<BoardCardDetail>) {
    Object.assign(this.cards.get(id)!, patch);
    this.cards.get(id)!.updatedAt = tick();
  }
  async board() {
    const cards = [...this.cards.values()].filter((c) => !this.gone.has(c.id) && !c.archivedAt);
    return {
      board: {
        id: BOARD,
        name: 'B',
        canManage: this.canManage,
        myRole: 'editor',
        settings: { labels: this.labels, fields: { points: true, priority: true } },
      },
      columns: [
        { id: TODO, name: 'Yapılacak', isDone: false },
        { id: DOING, name: 'Sürüyor', isDone: false },
        { id: DONE, name: 'Bitti', isDone: true },
      ],
      cards,
      people: [ali, ayse],
      archivedCount: 0,
    } as unknown as BoardDetail;
  }
  async card(id: string) {
    return this.gone.has(id) ? null : (this.cards.get(id) ?? null);
  }
  async createCard(_b: string, input: Parameters<CrewhallPort['createCard']>[1]) {
    const id = `card-${this.seq++}`;
    const now = tick();
    const c = {
      id,
      boardId: BOARD,
      columnId: input.columnId,
      number: this.seq,
      position: 'a',
      title: input.title,
      excerpt: '',
      description: input.description,
      labels: input.labels,
      assignees: [],
      dueAt: input.dueAt,
      startAt: input.startAt,
      points: null,
      priority: null,
      commentCount: 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      board: { id: BOARD, name: 'B', key: 'MLV', spaceId: 's', myRole: 'editor' },
    } as unknown as BoardCardDetail;
    this.cards.set(id, c);
    this.writes++;
    return c;
  }
  async updateCard(id: string, patch: Parameters<CrewhallPort['updateCard']>[1]) {
    const c = this.cards.get(id)!;
    const { archived, ...rest } = patch;
    Object.assign(c, rest);
    if (archived) c.archivedAt = tick();
    this.touch(c);
    return c;
  }
  async moveCard(id: string, columnId: string) {
    const c = this.cards.get(id)!;
    c.columnId = columnId;
    this.touch(c);
  }
  async setAssignees(id: string, userIds: string[]) {
    const c = this.cards.get(id)!;
    c.assignees = [ali, ayse].filter((p) => userIds.includes(p.id));
    this.touch(c);
  }
  async comments(id: string) {
    return this.activity.get(id) ?? [];
  }
  async addComment(id: string, text: string) {
    const list = this.activity.get(id) ?? [];
    const a = { id: `a-${this.seq++}`, text, author: 'Sen', createdAt: tick() };
    list.push(a);
    this.activity.set(id, list);
    const c = this.cards.get(id)!;
    c.commentCount = list.length;
    this.touch(c);
    return a.id;
  }
  async setLabels(_b: string, labels: BoardLabel[]) {
    this.labels = labels;
  }
}

const conn = { id: 'c1', provider: 'azure', installationId: 'i1' } as Connection;
const installation = { id: 'i1' } as Installation;

function makeSync(over: Partial<Sync> = {}): Sync {
  return {
    id: 's1',
    installationId: 'i1',
    ownerId: 'u-ali',
    connectionId: 'c1',
    boardId: BOARD,
    boardName: 'B',
    scope: { project: 'P', types: [], filter: '' },
    columnMap: { [TODO]: ['New'], [DOING]: ['Active'], [DONE]: ['Closed'] },
    direction: 'both',
    conflict: 'newest',
    comments: true,
    pushNewCards: false,
    defaultType: 'Task',
    timeZone: 'UTC',
    enabled: true,
    webhookToken: 't',
    webhookId: null,
    watermark: null,
    lastRunAt: null,
    lastError: null,
    linked: 0,
    createdAt: '2026-11-10T00:00:00.000Z',
    ...over,
  };
}

describe('sync engine', () => {
  let store: Store;
  let provider: FakeProvider;
  let crewhall: FakeCrewhall;
  let engine: Engine;
  const full = () => engine.request('s1', { full: true });
  const link = async (id: string) => (await store.get<Link>('link', `s1:${id}`))!;
  const cardOf = async (id: string) => crewhall.cards.get((await link(id)).cardId)!;
  const setup = async (over: Partial<Sync> = {}) => {
    await store.put('sync', 's1', 'i1', makeSync(over));
  };

  beforeEach(async () => {
    store = memoryStore();
    provider = new FakeProvider();
    crewhall = new FakeCrewhall();
    engine = new Engine({ store, providerFor: () => provider, crewhall: () => crewhall });
    await store.put('connection', 'c1', 'i1', conn);
    await store.put('installation', 'i1', 'all', installation);
    await setup();
  });

  it('imports work items as cards with their fields', async () => {
    provider.add('1', {
      status: 'Active',
      assignee: 'ayse@x.dev',
      priority: 'p1',
      points: 5,
      dueDate: '2026-12-01',
      labels: ['bug', 'yeni etiket'],
    });
    await full();
    const card = await cardOf('1');
    expect(card.title).toBe('Item 1');
    expect(card.columnId).toBe(DOING);
    expect(card.priority).toBe('p1');
    expect(card.points).toBe(5);
    expect(card.assignees.map((a) => a.id)).toEqual(['u-ayse']);
    expect(card.dueAt).toBe('2026-12-01T12:00:00.000Z');
    expect(crewhall.labels.map((l) => l.name)).toContain('yeni etiket');
    expect(card.labels).toHaveLength(2);
    expect((await store.get<Sync>('sync', 's1'))!.linked).toBe(1);
  });

  it('settles after its own writes: a second run changes nothing', async () => {
    provider.add('1');
    await full();
    const writes = crewhall.writes;
    provider.items.get('1')!.updatedAt = tick(); // the echo of a webhook
    await engine.request('s1', { extIds: ['1'] });
    await full();
    expect(crewhall.writes).toBe(writes);
    expect(provider.updates).toHaveLength(0);
  });

  it('carries an external change to the card', async () => {
    provider.add('1');
    await full();
    provider.edit('1', { title: 'Yeni başlık', status: 'Closed' });
    await engine.request('s1', { extIds: ['1'] });
    const card = await cardOf('1');
    expect(card.title).toBe('Yeni başlık');
    expect(card.columnId).toBe(DONE);
    expect(provider.updates).toHaveLength(0);
  });

  it('carries a card change to the work item, status through the map', async () => {
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    crewhall.edit(cardId, { title: 'Karttan', columnId: DOING });
    await engine.request('s1', { cardIds: [cardId] });
    expect(provider.items.get('1')!.fields.title).toBe('Karttan');
    expect(provider.items.get('1')!.fields.status).toBe('Active');
  });

  it('merges different fields changed on both sides without a conflict', async () => {
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    crewhall.edit(cardId, { title: 'Karttan' });
    provider.edit('1', { description: 'Azure tarafı' });
    await full();
    expect(provider.items.get('1')!.fields.title).toBe('Karttan');
    expect((await cardOf('1')).description).toBe('Azure tarafı');
    const logs = await store.list<LogEntry>('log', 's1');
    expect(logs.some((l) => l.level === 'conflict')).toBe(false);
  });

  it('settles a real conflict by the rule and logs it', async () => {
    await setup({ conflict: 'crewhall' });
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    provider.edit('1', { title: 'Azure' });
    crewhall.edit(cardId, { title: 'Crewhall' });
    await full();
    expect(provider.items.get('1')!.fields.title).toBe('Crewhall');
    expect((await cardOf('1')).title).toBe('Crewhall');
    const logs = await store.list<LogEntry>('log', 's1');
    expect(logs.some((l) => l.code === 'conflict_title')).toBe(true);
  });

  it('the newest rule follows the timestamps', async () => {
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    crewhall.edit(cardId, { title: 'Eski' });
    provider.edit('1', { title: 'Yeni' });
    await full();
    expect((await cardOf('1')).title).toBe('Yeni');
  });

  it('a one-way sync never writes to the other side', async () => {
    await setup({ direction: 'to_crewhall' });
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    crewhall.edit(cardId, { title: 'Karttan' });
    await full();
    expect(provider.updates).toHaveLength(0);
    expect((await cardOf('1')).title).toBe('Item 1');
  });

  it('leaves what cannot be mapped alone instead of erasing it', async () => {
    provider.add('1', { assignee: 'yabanci@x.dev', labels: ['bug', 'yalnız-azure'] });
    crewhall.canManage = false;
    await full();
    const card = await cardOf('1');
    expect(card.assignees).toEqual([]);
    crewhall.edit(card.id, { labels: [] });
    await full();
    // The assignee the board cannot show stays; the unknown label survives the label write.
    expect(provider.items.get('1')!.fields.assignee).toBe('yabanci@x.dev');
    expect(provider.items.get('1')!.fields.labels).toEqual(['yalnız-azure']);
  });

  it('keeps a second assignee on the card when the external one matches', async () => {
    provider.add('1', { assignee: 'ali@x.dev' });
    await full();
    const { cardId } = await link('1');
    crewhall.edit(cardId, { assignees: [ayse, ali] });
    await full();
    expect(provider.updates).toHaveLength(0);
    expect((await cardOf('1')).assignees).toHaveLength(2);
  });

  it('copies comments both ways once and never copies a copy', async () => {
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    const item = provider.items.get('1')!;
    provider.comments.set('1', [
      { id: 'e1', author: 'Veli', text: 'Azure yorumu', createdAt: tick() },
    ]);
    item.commentCount = 1;
    item.updatedAt = tick();
    await crewhall.addComment(cardId, 'Crewhall yorumu');
    await full();
    await full();
    provider.items.get('1')!.updatedAt = tick();
    await full();
    const local = crewhall.activity.get(cardId)!.map((a) => a.text);
    expect(local.filter((t) => t.includes('Azure yorumu'))).toHaveLength(1);
    expect(local.find((t) => t.includes('Azure yorumu'))).toBe(
      `${COPY_MARK}Veli (Azure DevOps): Azure yorumu`,
    );
    const remote = provider.comments.get('1')!.map((c) => c.text);
    expect(remote.filter((t) => t.includes('Crewhall yorumu'))).toHaveLength(1);
    expect(remote).toHaveLength(2);
  });

  it('pushes new cards only when asked, and only cards made after the sync', async () => {
    await setup({ pushNewCards: true });
    const old = await crewhall.createCard(BOARD, {
      columnId: TODO,
      title: 'Eski',
      description: '',
      labels: [],
      dueAt: null,
      startAt: null,
    });
    old.createdAt = '2026-01-01T00:00:00.000Z';
    const fresh = await crewhall.createCard(BOARD, {
      columnId: DOING,
      title: 'Taze',
      description: 'x',
      labels: [],
      dueAt: null,
      startAt: null,
    });
    await engine.request('s1', { cardIds: [fresh.id, old.id] });
    const items = [...provider.items.values()];
    expect(items).toHaveLength(1);
    expect(items[0]!.fields.title).toBe('Taze');
    expect(items[0]!.fields.status).toBe('Active');
  });

  it('archives the card when the work item is deleted and deletes nothing there', async () => {
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    provider.items.delete('1');
    await engine.request('s1', { extIds: ['1'] });
    expect(crewhall.cards.get(cardId)!.archivedAt).toBeTruthy();
    expect((await link('1')).removed).toBe(true);
  });

  it('ends the link when the card is deleted and leaves the work item', async () => {
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    crewhall.gone.add(cardId);
    await engine.request('s1', { cardIds: [cardId] });
    expect((await link('1')).removed).toBe(true);
    expect(provider.items.has('1')).toBe(true);
  });

  it('a failed write keeps the change for the next run', async () => {
    provider.add('1');
    await full();
    const { cardId } = await link('1');
    crewhall.edit(cardId, { title: 'Karttan' });
    provider.failNext = new ProviderError('conflict', 412);
    await full();
    expect(provider.items.get('1')!.fields.title).toBe('Item 1');
    expect((await store.get<Sync>('sync', 's1'))!.lastError).toBe('partial');
    crewhall.edit(cardId, {});
    await full();
    expect(provider.items.get('1')!.fields.title).toBe('Karttan');
    expect((await store.get<Sync>('sync', 's1'))!.lastError).toBeNull();
  });

  it('stops and tells the owner once when the token dies', async () => {
    const told: string[] = [];
    engine = new Engine({
      store,
      providerFor: () => provider,
      crewhall: () => crewhall,
      notify: async (_i, _s, code) => void told.push(code),
    });
    provider.projectMeta = async () => {
      throw new ProviderError('auth_failed', 401);
    };
    await full();
    await full();
    expect((await store.get<Sync>('sync', 's1'))!.lastError).toBe('auth_failed');
    expect(told).toEqual(['auth_failed']);
  });

  it('never runs one sync twice at once and folds requests together', async () => {
    let running = 0;
    let most = 0;
    const original = provider.changedSince.bind(provider);
    provider.changedSince = async (s, since) => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return original(s, since);
    };
    await Promise.all([full(), full(), full(), full()]);
    expect(most).toBe(1);
  });

  it('does nothing for a paused sync', async () => {
    await setup({ enabled: false });
    provider.add('1');
    await full();
    expect(crewhall.cards.size).toBe(0);
  });
});
