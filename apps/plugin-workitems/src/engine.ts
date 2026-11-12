import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BOARD_LIMITS,
  type BoardCard,
  type BoardCardDetail,
  type BoardDetail,
} from '@crewhall/shared';
import { CrewhallApiError } from '@crewhall/plugin-sdk/server';
import { ApiError } from '@crewhall/api-client';
import type { CrewhallPort } from './crewhall';
import { merge, type CanonView } from './merge';
import type { Store } from './store';
import { clip, dateIn, dateToTimestamp, normalizeText } from './text';
import {
  ProviderError,
  type Canon,
  type Connection,
  type ExternalItem,
  type FieldsPatch,
  type Installation,
  type Link,
  type LogEntry,
  type LogLevel,
  type ProjectMeta,
  type Provider,
  type Sync,
} from './types';

/**
 * The sync. Every trigger (a webhook, a card event, the timer) only says "look at these"; a run
 * then reads both sides as they are now and merges against the last agreed state. Payloads are
 * never trusted and repeats are harmless, so a change that comes back from our own write ends
 * as a merge with nothing to do. Runs of one sync never overlap.
 */

const MAX_CHANGED_PER_RUN = 500;
const MAX_CREATES_PER_RUN = 100;
/** Clocks differ; a run re-reads a little of what the last one saw. */
const WATERMARK_SKEW_MS = 120_000;
const LOG_KEEP = 200;
/** Starts every comment we copy, so a copy is never copied back even if its link was lost. */
export const COPY_MARK = '↪ ';
const LABEL_COLORS = ['s1', 's2', 's3', 's4', 's5', 's6', 'info'] as const;

export interface EngineDeps {
  store: Store;
  providerFor(conn: Connection): Provider;
  crewhall(installation: Installation, userId: string): CrewhallPort;
  /** Tells the sync's owner it stopped working (once per reason). */
  notify?(installation: Installation, sync: Sync, code: string): Promise<void>;
  onError?(err: unknown, syncId: string): void;
}

export interface Hint {
  full: boolean;
  extIds: string[];
  cardIds: string[];
}

const labelKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
const providerLabel = (c: Connection) => (c.provider === 'azure' ? 'Azure DevOps' : 'Jira');
const newest = (a: string, b: string) => Date.parse(a) >= Date.parse(b);

function errorCode(err: unknown): string {
  if (err instanceof ProviderError) return err.code;
  if (err instanceof ApiError || err instanceof CrewhallApiError) return String(err.code);
  return 'internal';
}

const FATAL = new Set([
  'auth_failed',
  'plugin_offline_not_granted',
  'plugin_disabled',
  'unauthenticated',
]);

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Everything one run needs to translate between the two worlds. */
class RunContext {
  readonly people: Map<string, BoardDetail['people'][number]>;
  readonly statusToColumn = new Map<string, string>();
  readonly labelsByKey: Map<string, string>;
  readonly labelName: Map<string, string>;

  constructor(
    readonly sync: Sync,
    readonly conn: Connection,
    readonly board: BoardDetail,
    readonly meta: ProjectMeta,
  ) {
    this.people = new Map(board.people.map((p) => [p.email.toLowerCase(), p]));
    for (const [column, statuses] of Object.entries(sync.columnMap)) {
      for (const s of statuses) this.statusToColumn.set(s.toLowerCase(), column);
    }
    const labels = board.board.settings.labels;
    this.labelsByKey = new Map(labels.map((l) => [labelKey(l.name), l.id]));
    this.labelName = new Map(labels.map((l) => [l.id, l.name]));
  }

  get showsPoints() {
    return this.board.board.settings.fields.points;
  }
  get showsPriority() {
    return this.board.board.settings.fields.priority;
  }

  /** External labels the board knows, as the board writes them. */
  knownLabels(item: ExternalItem) {
    const ids = item.fields.labels.map((l) => this.labelsByKey.get(labelKey(l)));
    return ids
      .filter((id): id is string => !!id)
      .map((id) => this.labelName.get(id)!)
      .sort();
  }

  /** What the external side says, in the terms both sides compare. */
  external(item: ExternalItem): CanonView {
    const f = item.fields;
    const email = f.assignee;
    // Someone the board cannot assign is not something the card can agree or disagree with.
    const assignee =
      email === undefined
        ? undefined
        : email === null
          ? null
          : this.people.has(email)
            ? email
            : undefined;
    const startDate = f.startDate && f.dueDate && f.startDate > f.dueDate ? undefined : f.startDate;
    return {
      title: clip(f.title.trim(), BOARD_LIMITS.titleLength),
      description: clip(normalizeText(f.description), BOARD_LIMITS.descriptionLength),
      column: this.statusToColumn.get(f.status.toLowerCase()),
      assignee,
      priority: this.showsPriority ? f.priority : undefined,
      dueDate: f.dueDate,
      startDate,
      labels: this.knownLabels(item),
      points: this.showsPoints ? f.points : undefined,
    };
  }

  /** What the card says. With several assignees the external one counts if it is among them. */
  card(card: BoardCard & { description?: string }, external?: string | null): CanonView {
    const emails = card.assignees.map((a) => a.email.toLowerCase());
    const zone = this.sync.timeZone;
    return {
      title: card.title.trim(),
      description: card.description === undefined ? undefined : normalizeText(card.description),
      column: card.columnId,
      assignee: external && emails.includes(external) ? external : (emails[0] ?? null),
      priority: this.showsPriority ? card.priority : undefined,
      dueDate: dateIn(card.dueAt, zone),
      startDate: dateIn(card.startAt, zone),
      labels: card.labels.map((id) => this.labelName.get(id) ?? id).sort(),
      points: this.showsPoints ? card.points : undefined,
    };
  }

  labelIds(names: string[]) {
    return names.map((n) => this.labelsByKey.get(labelKey(n))).filter((id): id is string => !!id);
  }

  /** The status to write for a column: the first mapped one this work item type has. */
  statusFor(column: string, type: string): string | undefined {
    const mapped = this.sync.columnMap[column] ?? [];
    const valid = new Set(
      this.meta.statuses.filter((s) => s.types.includes(type)).map((s) => s.name.toLowerCase()),
    );
    return mapped.find((s) => valid.has(s.toLowerCase()));
  }
}

function filled(view: CanonView, fallback: Canon): Canon {
  const out: Record<string, unknown> = { ...fallback };
  for (const [k, v] of Object.entries(view)) if (v !== undefined) out[k] = v;
  return out as unknown as Canon;
}

export class Engine {
  private readonly runs = new Map<string, { hint: Hint | null; done: Promise<void> }>();

  constructor(private readonly deps: EngineDeps) {}

  /** Asks for a run; requests that arrive during one are folded into the next. */
  request(syncId: string, hint: Partial<Hint> = {}): Promise<void> {
    const incoming: Hint = {
      full: hint.full ?? false,
      extIds: hint.extIds ?? [],
      cardIds: hint.cardIds ?? [],
    };
    const state = this.runs.get(syncId);
    if (state) {
      state.hint = state.hint
        ? {
            full: state.hint.full || incoming.full,
            extIds: [...new Set([...state.hint.extIds, ...incoming.extIds])],
            cardIds: [...new Set([...state.hint.cardIds, ...incoming.cardIds])],
          }
        : incoming;
      return state.done;
    }
    const entry: { hint: Hint | null; done: Promise<void> } = {
      hint: incoming,
      done: Promise.resolve(),
    };
    entry.done = (async () => {
      try {
        while (entry.hint) {
          const current = entry.hint;
          entry.hint = null;
          try {
            await this.run(syncId, current);
          } catch (err) {
            this.deps.onError?.(err, syncId);
          }
        }
      } finally {
        this.runs.delete(syncId);
      }
    })();
    this.runs.set(syncId, entry);
    return entry.done;
  }

  private async log(syncId: string, level: LogLevel, code: string, item?: string, detail?: string) {
    const entry: LogEntry = {
      at: new Date().toISOString(),
      level,
      code,
      ...(item ? { item } : {}),
      ...(detail ? { detail } : {}),
    };
    // Newest first when listed: the id counts down.
    const id = `${String(9_999_999_999_999 - Date.now()).padStart(13, '0')}-${randomBytes(3).toString('hex')}`;
    await this.deps.store.put('log', `${syncId}:${id}`, syncId, entry);
  }

  private async finish(sync: Sync, patch: Partial<Sync>) {
    const fresh = await this.deps.store.get<Sync>('sync', sync.id);
    if (!fresh) return;
    await this.deps.store.put('sync', sync.id, sync.installationId, { ...fresh, ...patch });
    const logs = await this.deps.store.list<LogEntry>('log', sync.id);
    if (logs.length > LOG_KEEP * 1.5) {
      // Listing gives entries, not ids: rebuild the newest ones under fresh ids.
      await this.deps.store.delScope('log', sync.id);
      for (const e of logs.slice(0, LOG_KEEP).reverse()) {
        await this.log(sync.id, e.level, e.code, e.item, e.detail);
      }
    }
  }

  private async run(syncId: string, hint: Hint) {
    const { store } = this.deps;
    const sync = await store.get<Sync>('sync', syncId);
    if (!sync?.enabled) return;
    const [conn, installation] = await Promise.all([
      store.get<Connection>('connection', sync.connectionId),
      store.get<Installation>('installation', sync.installationId),
    ]);
    if (!installation) return;
    if (!conn) {
      await this.finish(sync, { lastError: 'connection_missing' });
      return;
    }
    const started = new Date().toISOString();
    try {
      await this.body(sync, conn, installation, hint, started);
    } catch (err) {
      const code = errorCode(err);
      await this.log(
        sync.id,
        'error',
        code,
        undefined,
        err instanceof Error ? err.message.slice(0, 300) : undefined,
      );
      await this.finish(sync, { lastError: code, lastRunAt: started });
      if (FATAL.has(code) && sync.lastError !== code) {
        await this.deps.notify?.(installation, sync, code).catch(() => undefined);
      }
    }
  }

  private async body(
    sync: Sync,
    conn: Connection,
    installation: Installation,
    hint: Hint,
    started: string,
  ) {
    const provider = this.deps.providerFor(conn);
    const crewhall = this.deps.crewhall(installation, sync.ownerId);
    const board = await crewhall.board(sync.boardId);
    const meta = await provider.projectMeta(sync.scope.project);
    const links = await this.deps.store.list<Link>('link', sync.id);
    const byExt = new Map(links.map((l) => [l.extId, l]));
    const byCard = new Map(links.map((l) => [l.cardId, l]));
    let failures = 0;
    let creates = 0;
    let capped = false;

    let ctx = new RunContext(sync, conn, board, meta);
    const attempt = async (name: string, work: () => Promise<void>) => {
      try {
        await work();
      } catch (err) {
        const code = errorCode(err);
        if (FATAL.has(code)) throw err;
        failures++;
        await this.log(
          sync.id,
          'error',
          code,
          name,
          err instanceof Error ? err.message.slice(0, 300) : undefined,
        );
      }
    };

    // ---- what changed over there
    const changed: ExternalItem[] = [];
    if (hint.full) {
      const since = sync.watermark
        ? new Date(Date.parse(sync.watermark) - WATERMARK_SKEW_MS).toISOString()
        : null;
      changed.push(...(await provider.changedSince(sync.scope, since, MAX_CHANGED_PER_RUN)));
      if (changed.length >= MAX_CHANGED_PER_RUN) capped = true;
    }
    for (const id of hint.extIds) {
      if (changed.some((i) => i.id === id)) continue;
      const item = await provider.getItem(id);
      if (item) {
        // A webhook is for the whole project; only what this sync covers counts.
        if (byExt.has(id) || this.inScope(sync, item)) changed.push(item);
      } else if (byExt.has(id)) {
        await attempt(byExt.get(id)!.extKey, () =>
          this.externalGone(sync, crewhall, byExt.get(id)!),
        );
      }
    }

    // New labels first, so the items below can use them.
    if (sync.direction !== 'to_external' && board.board.canManage) {
      const before = board.board.settings.labels.length;
      await attempt('labels', async () => {
        await this.addMissingLabels(crewhall, board, changed);
      });
      if (board.board.settings.labels.length !== before)
        ctx = new RunContext(sync, conn, board, meta);
    }

    const cards = new Map(board.cards.map((c) => [c.id, c]));
    const visited = new Set<string>();

    for (const item of changed) {
      const link = byExt.get(item.id);
      if (link) {
        if (link.removed || item.updatedAt === link.extUpdatedAt) continue;
        visited.add(link.cardId);
        await attempt(item.key, () => this.pair(ctx, provider, crewhall, link, item));
      } else if (sync.direction !== 'to_external' && !item.removed) {
        if (creates >= MAX_CREATES_PER_RUN) {
          capped = true;
          continue;
        }
        creates++;
        await attempt(item.key, async () => {
          const made = await this.importItem(ctx, provider, crewhall, item);
          byExt.set(item.id, made);
          byCard.set(made.cardId, made);
        });
      }
    }

    // ---- what changed here
    const cardIds = new Set(hint.cardIds);
    if (hint.full) for (const c of board.cards) cardIds.add(c.id);
    for (const cardId of cardIds) {
      if (visited.has(cardId)) continue;
      const link = byCard.get(cardId);
      const summary = cards.get(cardId);
      if (link) {
        if (link.removed) continue;
        if (!summary) {
          // Archived or deleted: only a card that is really gone ends the link.
          const card = await crewhall.card(cardId);
          if (!card) await attempt(link.extKey, () => this.cardGone(sync, link));
          continue;
        }
        if (summary.updatedAt === link.cardUpdatedAt) continue;
        await attempt(link.cardKey, () => this.pair(ctx, provider, crewhall, link, null));
      } else if (
        summary &&
        sync.pushNewCards &&
        sync.direction !== 'to_crewhall' &&
        Date.parse(summary.createdAt) >= Date.parse(sync.createdAt)
      ) {
        if (creates >= MAX_CREATES_PER_RUN) {
          capped = true;
          continue;
        }
        creates++;
        await attempt(summary.title, async () => {
          const made = await this.pushCard(ctx, provider, crewhall, cardId);
          byExt.set(made.extId, made);
          byCard.set(made.cardId, made);
        });
      }
    }

    const patch: Partial<Sync> = {
      lastRunAt: started,
      lastError: failures ? 'partial' : capped ? 'continuing' : null,
      linked: [...byExt.values()].filter((l) => !l.removed).length,
    };
    // The mark only moves past what was fully handled; the rest is read again next time.
    if (hint.full && !failures && !capped) patch.watermark = started;
    await this.finish(sync, patch);
    if (capped) void this.request(sync.id, { full: true });
  }

  private inScope(sync: Sync, item: ExternalItem) {
    if (item.project !== sync.scope.project) return false;
    return !sync.scope.types.length || sync.scope.types.includes(item.type);
  }

  private async saveLink(sync: Sync, link: Link) {
    await this.deps.store.put('link', `${sync.id}:${link.extId}`, sync.id, link);
  }

  private async addMissingLabels(
    crewhall: CrewhallPort,
    board: BoardDetail,
    items: ExternalItem[],
  ) {
    const labels = board.board.settings.labels;
    const known = new Set(labels.map((l) => labelKey(l.name)));
    const fresh = new Map<string, string>();
    for (const item of items) {
      for (const name of item.fields.labels) {
        const key = labelKey(name);
        if (!known.has(key) && !fresh.has(key)) fresh.set(key, name);
      }
    }
    if (!fresh.size) return;
    const room = BOARD_LIMITS.labels - labels.length;
    const added = [...fresh.values()].slice(0, Math.max(0, room)).map((name, i) => ({
      id: randomBytes(5).toString('hex'),
      name: clip(name.trim(), 40),
      color: LABEL_COLORS[(labels.length + i) % LABEL_COLORS.length]!,
    }));
    if (!added.length) return;
    const next = [...labels, ...added];
    await crewhall.setLabels(board.board.id, next);
    board.board.settings.labels = next;
  }

  private cardPatch(ctx: RunContext, toCard: Partial<Canon>) {
    const patch: Parameters<CrewhallPort['updateCard']>[1] = {};
    if (toCard.title !== undefined) patch.title = toCard.title;
    if (toCard.description !== undefined) patch.description = toCard.description;
    if (toCard.labels !== undefined) patch.labels = ctx.labelIds(toCard.labels);
    if (toCard.dueDate !== undefined) patch.dueAt = dateToTimestamp(toCard.dueDate);
    if (toCard.startDate !== undefined) patch.startAt = dateToTimestamp(toCard.startDate);
    if (toCard.points !== undefined) patch.points = toCard.points;
    if (toCard.priority !== undefined) patch.priority = toCard.priority;
    return patch;
  }

  private async writeCard(
    ctx: RunContext,
    crewhall: CrewhallPort,
    card: BoardCardDetail,
    toCard: Partial<Canon>,
  ) {
    const patch = this.cardPatch(ctx, toCard);
    if (Object.keys(patch).length) await crewhall.updateCard(card.id, patch);
    if (toCard.column !== undefined) await crewhall.moveCard(card.id, toCard.column);
    if (toCard.assignee !== undefined) {
      const others = card.assignees.slice(1).map((a) => a.id);
      const target = toCard.assignee ? ctx.people.get(toCard.assignee)?.id : undefined;
      await crewhall.setAssignees(
        card.id,
        toCard.assignee ? [...(target ? [target] : []), ...others.filter((o) => o !== target)] : [],
      );
    }
  }

  /** `toExternal` as the provider's patch. Labels the board does not know are left in place. */
  private externalPatch(ctx: RunContext, item: ExternalItem, toExternal: Partial<Canon>) {
    const patch: FieldsPatch = {};
    if (toExternal.title !== undefined) patch.title = toExternal.title;
    if (toExternal.description !== undefined) patch.description = toExternal.description;
    if (toExternal.assignee !== undefined) patch.assignee = toExternal.assignee;
    if (toExternal.priority !== undefined) patch.priority = toExternal.priority;
    if (toExternal.dueDate !== undefined) patch.dueDate = toExternal.dueDate;
    if (toExternal.startDate !== undefined) patch.startDate = toExternal.startDate;
    if (toExternal.points !== undefined) patch.points = toExternal.points;
    if (toExternal.labels !== undefined) {
      const foreign = item.fields.labels.filter((l) => !ctx.labelsByKey.has(labelKey(l)));
      patch.labels = [...foreign, ...toExternal.labels];
    }
    return patch;
  }

  private async pair(
    ctx: RunContext,
    provider: Provider,
    crewhall: CrewhallPort,
    link: Link,
    known: ExternalItem | null,
  ) {
    const { sync } = ctx;
    const item = known ?? (await provider.getItem(link.extId));
    if (!item || item.removed) {
      await this.externalGone(sync, crewhall, link);
      return;
    }
    const card = await crewhall.card(link.cardId);
    if (!card) {
      await this.cardGone(sync, link);
      return;
    }
    const external = ctx.external(item);
    const result = merge({
      base: link.base,
      external,
      card: ctx.card(card, item.fields.assignee),
      direction: sync.direction,
      conflict: sync.conflict,
      externalIsNewer: newest(item.updatedAt, card.updatedAt),
    });
    for (const field of result.conflicts) {
      await this.log(sync.id, 'conflict', `conflict_${field}`, item.key, sync.conflict);
    }

    let touchedCard = false;
    if (Object.keys(result.toCard).length) {
      await this.writeCard(ctx, crewhall, card, result.toCard);
      touchedCard = true;
      await this.log(
        sync.id,
        'info',
        'updated_card',
        item.key,
        Object.keys(result.toCard).join(', '),
      );
    }

    let current = item;
    const toExternal = { ...result.toExternal };
    const next = { ...result.next };
    let status: string | undefined;
    if (toExternal.column !== undefined) {
      status = ctx.statusFor(toExternal.column, item.type);
      if (!status) {
        await this.log(sync.id, 'error', 'no_status_for_column', item.key, item.type);
        if (external.column !== undefined) next.column = external.column;
      }
      delete toExternal.column;
    }
    const patch = this.externalPatch(ctx, item, toExternal);
    if (status && status !== item.fields.status) patch.status = status;
    if (Object.keys(patch).length) {
      current = await provider.updateItem(item, patch);
      await this.log(sync.id, 'info', 'updated_external', item.key, Object.keys(patch).join(', '));
    }

    let updated: Link = {
      ...link,
      base: next,
      extUpdatedAt: current.updatedAt,
      extComments: current.commentCount,
      cardComments: card.commentCount,
      cardUpdatedAt: card.updatedAt,
    };
    await this.saveLink(sync, updated);
    const commented = sync.comments
      ? await this.syncComments(ctx, provider, crewhall, updated, current, card)
      : null;
    if (commented) updated = commented;
    if (touchedCard || commented) {
      const fresh = await crewhall.card(link.cardId);
      if (fresh)
        updated = { ...updated, cardUpdatedAt: fresh.updatedAt, cardComments: fresh.commentCount };
      const freshItem = commented ? await provider.getItem(link.extId) : null;
      if (freshItem) {
        updated = {
          ...updated,
          extUpdatedAt: freshItem.updatedAt,
          extComments: freshItem.commentCount,
        };
      }
      await this.saveLink(sync, updated);
    }
  }

  /** Copies comments neither side has seen. Each copy is recorded before the next one starts. */
  private async syncComments(
    ctx: RunContext,
    provider: Provider,
    crewhall: CrewhallPort,
    link: Link,
    item: ExternalItem,
    card: BoardCardDetail,
  ): Promise<Link | null> {
    if (
      item.commentCount === link.extComments &&
      card.commentCount === link.cardComments &&
      Object.keys(link.comments).length
    ) {
      return null;
    }
    if (!item.commentCount && !card.commentCount) return null;
    const { sync, conn } = ctx;
    const [external, local] = await Promise.all([
      item.commentCount ? provider.listComments(item) : Promise.resolve([]),
      card.commentCount ? crewhall.comments(card.id) : Promise.resolve([]),
    ]);
    const comments = { ...link.comments };
    const seenLocal = new Set(Object.values(comments));
    let changed = false;
    const remember = async () => {
      changed = true;
      await this.saveLink(sync, { ...link, comments });
    };
    if (sync.direction !== 'to_external') {
      for (const c of external) {
        if (comments[c.id] || c.text.startsWith(COPY_MARK) || !c.text.trim()) continue;
        const text = clip(
          `${COPY_MARK}${c.author} (${providerLabel(conn)}): ${c.text}`,
          BOARD_LIMITS.commentLength,
        );
        const id = await crewhall.addComment(card.id, text);
        comments[c.id] = id;
        seenLocal.add(id);
        await remember();
      }
    }
    if (sync.direction !== 'to_crewhall') {
      for (const c of local) {
        if (seenLocal.has(c.id) || c.text.startsWith(COPY_MARK)) continue;
        const id = await provider.addComment(item, `${COPY_MARK}${c.author} (Crewhall): ${c.text}`);
        comments[id] = c.id;
        seenLocal.add(c.id);
        await remember();
      }
    }
    return changed ? { ...link, comments } : null;
  }

  private async importItem(
    ctx: RunContext,
    provider: Provider,
    crewhall: CrewhallPort,
    item: ExternalItem,
  ): Promise<Link> {
    const { sync, conn, board } = ctx;
    const external = ctx.external(item);
    const firstOpen = board.columns.find((c) => !c.isDone) ?? board.columns[0];
    if (!firstOpen) throw new ProviderError('no_columns');
    const columnId = external.column ?? firstOpen.id;
    const created = await crewhall.createCard(sync.boardId, {
      columnId,
      title: external.title || item.key,
      description: external.description ?? '',
      labels: ctx.labelIds(external.labels ?? []),
      dueAt: dateToTimestamp(external.dueDate ?? null),
      startAt: dateToTimestamp(external.startDate ?? null),
    });
    const extras = this.cardPatch(ctx, {
      ...(external.points != null ? { points: external.points } : {}),
      ...(external.priority != null ? { priority: external.priority } : {}),
    });
    if (Object.keys(extras).length) await crewhall.updateCard(created.id, extras);
    if (external.assignee) {
      await crewhall.setAssignees(created.id, [ctx.people.get(external.assignee)!.id]);
    }
    const note = await crewhall.addComment(
      created.id,
      `${COPY_MARK}${providerLabel(conn)} ${item.key}: ${item.url}`,
    );
    void note;
    const card = (await crewhall.card(created.id)) ?? created;
    const seen = filled(ctx.card(card, item.fields.assignee), {
      title: '',
      description: '',
      column: columnId,
      assignee: null,
      priority: null,
      dueDate: null,
      startDate: null,
      labels: [],
      points: null,
    });
    const link: Link = {
      syncId: sync.id,
      extId: item.id,
      extKey: item.key,
      extUrl: item.url,
      extUpdatedAt: item.updatedAt,
      extComments: 0,
      cardId: card.id,
      cardKey: `${card.board.key}-${card.number}`,
      cardUpdatedAt: card.updatedAt,
      cardComments: card.commentCount,
      base: filled(external, seen),
      comments: {},
      removed: false,
    };
    await this.saveLink(sync, link);
    await this.log(sync.id, 'info', 'imported', item.key, link.cardKey);
    if (sync.comments && item.commentCount) {
      const copied = await this.syncComments(ctx, provider, crewhall, link, item, card);
      if (copied) {
        const fresh = await crewhall.card(card.id);
        const updated = {
          ...copied,
          extComments: item.commentCount,
          cardUpdatedAt: fresh?.updatedAt ?? card.updatedAt,
          cardComments: fresh?.commentCount ?? card.commentCount,
        };
        await this.saveLink(sync, updated);
        return updated;
      }
    }
    return link;
  }

  private async pushCard(
    ctx: RunContext,
    provider: Provider,
    crewhall: CrewhallPort,
    cardId: string,
  ): Promise<Link> {
    const { sync, conn } = ctx;
    const card = await crewhall.card(cardId);
    if (!card) throw new ProviderError('not_found');
    const view = ctx.card(card);
    const status = ctx.statusFor(card.columnId, sync.defaultType);
    const item = await provider.createItem(sync.scope, sync.defaultType, {
      title: view.title,
      description: view.description ?? '',
      ...(status ? { status } : {}),
      ...(view.assignee ? { assignee: view.assignee } : {}),
      ...(view.priority ? { priority: view.priority } : {}),
      ...(view.dueDate ? { dueDate: view.dueDate } : {}),
      ...(view.startDate ? { startDate: view.startDate } : {}),
      ...(view.points != null ? { points: view.points } : {}),
      labels: view.labels ?? [],
    });
    await crewhall.addComment(
      card.id,
      `${COPY_MARK}${providerLabel(conn)} ${item.key}: ${item.url}`,
    );
    const fresh = (await crewhall.card(cardId)) ?? card;
    const base = filled(ctx.card(fresh, item.fields.assignee), {
      title: view.title ?? '',
      description: view.description ?? '',
      column: card.columnId,
      assignee: null,
      priority: null,
      dueDate: null,
      startDate: null,
      labels: [],
      points: null,
    });
    const link: Link = {
      syncId: sync.id,
      extId: item.id,
      extKey: item.key,
      extUrl: item.url,
      extUpdatedAt: item.updatedAt,
      extComments: item.commentCount,
      cardId,
      cardKey: `${card.board.key}-${card.number}`,
      cardUpdatedAt: fresh.updatedAt,
      cardComments: fresh.commentCount,
      base,
      comments: {},
      removed: false,
    };
    await this.saveLink(sync, link);
    await this.log(sync.id, 'info', 'pushed', card.title, item.key);
    return link;
  }

  /** The work item is gone: the card is archived, never deleted. */
  private async externalGone(sync: Sync, crewhall: CrewhallPort, link: Link) {
    if (sync.direction !== 'to_external') {
      await crewhall.updateCard(link.cardId, { archived: true });
    }
    await this.saveLink(sync, { ...link, removed: true });
    await this.log(sync.id, 'info', 'external_removed', link.extKey, link.cardKey);
  }

  /** The card is gone: the work item stays, the link ends. Nothing is deleted over there. */
  private async cardGone(sync: Sync, link: Link) {
    await this.saveLink(sync, { ...link, removed: true });
    await this.log(sync.id, 'info', 'card_removed', link.cardKey, link.extKey);
  }
}
