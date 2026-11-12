import {
  MAIL_BULK_CHUNK,
  type MailBulkAction,
  type MailFolder,
  type MailMessage,
  type MailMessageSummary,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  Checkbox,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Segmented,
  Skeleton,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { ConfirmDialog } from '@/components/identity/parts';
import { api, idempotencyKey } from '@/lib/api';
import { formatNumber, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { middleClickOpens, newTabLabel, openInNewTab } from '@/lib/newTab';
import { patchLists, type Target } from '@/lib/mail/bulk';
import { sameAddress, type ComposeMode } from '@/lib/mail/compose';
import { VirtualList } from '@/components/vault/VirtualList';
import { mailMessagesQuery, mailThreadQuery, type MailListFilter } from '@/lib/mail/queries';
import { mailError } from './errors';
import { isAuthProblem } from './MailGate';
import { folderLabel } from './MailSidebar';
import { useDelayed } from './useDelayed';
import { useMailBulk } from './useMailBulk';
import { ResizablePane } from '@/components/shell/ResizablePane';

export interface ConversationRow {
  /** Newest message of the conversation in this folder (the one that opens). */
  latest: MailMessageSummary;
  /** Every loaded message of the conversation in this folder (bulk actions use them all). */
  uids: number[];
  count: number;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

/** Messages of one page grouped by conversation, newest first (Gmail-style rows). */
/** The current list with this message open, for a new tab. */
function messageHref(uid: number): string {
  const url = new URL(window.location.href);
  url.searchParams.set('uid', String(uid));
  return url.toString();
}

export function groupConversations(items: MailMessageSummary[]): ConversationRow[] {
  const rows = new Map<string, ConversationRow>();
  for (const m of items) {
    const row = rows.get(m.threadId);
    if (!row) {
      rows.set(m.threadId, {
        latest: m,
        uids: [m.uid],
        count: 1,
        unread: !m.seen,
        flagged: m.flagged,
        hasAttachments: m.hasAttachments,
      });
      continue;
    }
    row.uids.push(m.uid);
    row.count += 1;
    row.unread ||= !m.seen;
    row.flagged ||= m.flagged;
    row.hasAttachments ||= m.hasAttachments;
  }
  return [...rows.values()];
}

const rowKey = (r: ConversationRow) => r.latest.threadId;

/** Inclusive range of rows between two indexes, whichever comes first. */
export function rowRange<T>(rows: T[], from: number, to: number): T[] {
  const [a, b] = from <= to ? [from, to] : [to, from];
  return rows.slice(a, b + 1);
}

/** Typing in a field or an open dialog keeps its own keys. */
function ownKeys(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return true;
  return Boolean(document.querySelector('[role="dialog"]'));
}

export function MessageList({
  filter,
  onFilter,
  selected,
  onSelect,
  onRemoved,
  me,
  folder,
  folders,
  onCompose,
}: {
  filter: MailListFilter;
  onFilter: (f: Partial<MailListFilter>) => void;
  /** The open message (Shift+I / Shift+U act on it when nothing is selected). */
  selected: number | null;
  onSelect: (uid: number) => void;
  /**
   * Messages left the folder or became unread: close the open conversation if it was among
   * them (moved, deleted, or it would be marked read again on its next refresh).
   */
  onRemoved: (uids: number[]) => void;
  me: string;
  folder: MailFolder | undefined;
  folders: MailFolder[];
  /** Reply, reply all or forward from a row's right-click menu. */
  onCompose: (mode: ComposeMode, message: MailMessage) => void;
}) {
  const { t, locale } = useI18n();
  const full = useInfiniteQuery(mailMessagesQuery(filter));
  // Search answers twice: header matches from the server's cache at once, then the full-text
  // result (bodies too) replaces them.
  const quick = useInfiniteQuery({
    ...mailMessagesQuery({ ...filter, scope: 'headers' }),
    enabled: Boolean(filter.q) && !full.data,
  });
  const list = filter.q && !full.data && quick.data ? quick : full;
  const slow = useDelayed(list.isPending);
  const qc = useQueryClient();
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Loads a conversation before it is opened (hover, keyboard); never marks it read. */
  const prefetch = (uid: number) =>
    void qc.prefetchQuery(mailThreadQuery(filter.folder, uid, false));
  const bulk = useMailBulk();
  const [query, setQuery] = useState(filter.q ?? '');
  // The box follows the URL when the search changes from outside (back button, a link).
  const [shownQ, setShownQ] = useState(filter.q);
  if (shownQ !== filter.q) {
    setShownQ(filter.q);
    setQuery(filter.q ?? '');
  }
  // Search after a short pause in typing.
  useEffect(() => {
    const next = query.trim();
    if (next === (filter.q ?? '')) return;
    const timer = setTimeout(() => onFilter({ q: next || undefined }), 350);
    return () => clearTimeout(timer);
  }, [query, filter.q, onFilter]);

  const rows = useMemo(
    () => groupConversations(list.data?.pages.flatMap((p) => p.items) ?? []),
    [list.data],
  );

  // Selection: conversation keys, the anchor of Shift+click, and "every message in the folder".
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [allInFolder, setAllInFolder] = useState(false);
  const anchor = useRef<number | null>(null);
  const scope = `${filter.folder}\n${filter.q ?? ''}\n${filter.filter}`;
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setPicked(new Set());
    setAllInFolder(false);
  }
  const chosen = rows.filter((r) => picked.has(rowKey(r)));
  const selecting = chosen.length > 0 || allInFolder;
  const clear = () => {
    setPicked(new Set());
    setAllInFolder(false);
    anchor.current = null;
  };
  const loadedMessages = rows.reduce((n, r) => n + r.count, 0);
  const folderTotal = folder?.total ?? 0;
  // A folder-wide job ignores search and filters, so it is offered on the plain list only.
  const canPickFolder =
    !filter.q &&
    filter.filter === 'all' &&
    chosen.length === rows.length &&
    folderTotal > loadedMessages;

  const toggle = (index: number, e: MouseEvent) => {
    const row = rows[index]!;
    const on = !picked.has(rowKey(row));
    setAllInFolder(false);
    setPicked((prev) => {
      const next = new Set(prev);
      const span =
        e.shiftKey && anchor.current !== null ? rowRange(rows, anchor.current, index) : [row];
      for (const r of span) {
        if (on) next.add(rowKey(r));
        else next.delete(rowKey(r));
      }
      return next;
    });
    anchor.current = index;
  };
  const pickAll = () => {
    setPicked(new Set(rows.map(rowKey)));
    anchor.current = null;
  };

  const run = async (action: MailBulkAction, moveTo?: string) => {
    const target: Target = allInFolder
      ? { kind: 'folder' }
      : { kind: 'uids', uids: chosen.flatMap((r) => r.uids) };
    const uids = target.kind === 'uids' ? target.uids : rows.flatMap((r) => r.uids);
    if (action === 'move' || action === 'delete') clear();
    // Opening a conversation marks it read again, so an unread one goes back to the list.
    if (action !== 'seen') onRemoved(uids);
    await bulk(filter.folder, action, target, moveTo);
  };

  // Shift+I / Shift+U: the selection, or the open conversation.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || ownKeys(e.target)) return;
      const key = e.key.toLowerCase();
      if (key !== 'i' && key !== 'u') return;
      const action = key === 'i' ? 'seen' : 'unseen';
      if (selecting) {
        e.preventDefault();
        void run(action);
        return;
      }
      const open = rows.find((r) => selected !== null && r.uids.includes(selected));
      if (!open) return;
      e.preventDefault();
      if (action === 'unseen') onRemoved(open.uids);
      void bulk(filter.folder, action, { kind: 'uids', uids: open.uids });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const activeIndex = rows.findIndex((r) => selected !== null && r.uids.includes(selected));
  const step = (by: 1 | -1) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, activeIndex + by))];
    if (!next) return;
    onSelect(next.latest.uid);
    const after = rows[rows.indexOf(next) + by];
    if (after) prefetch(after.latest.uid);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-mail-row="${next.latest.uid}"]`)?.focus(),
    );
  };
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    if (ownKeys(e.target)) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (plain && (e.key === 'j' || e.key === 'ArrowDown')) {
      e.preventDefault();
      step(1);
    } else if (plain && (e.key === 'k' || e.key === 'ArrowUp')) {
      e.preventDefault();
      step(-1);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && rows.length) {
      e.preventDefault();
      pickAll();
    } else if (e.key === 'Escape' && selecting) {
      e.preventDefault();
      clear();
    }
  };

  const targets = folders.filter((f) => f.path !== filter.folder);
  const num = (n: number) => formatNumber(n, locale);
  const inTrash = folder?.specialUse === 'trash';
  // Deleting from Trash is for good: the menu asks first, as the conversation view does.
  const [purge, setPurge] = useState<(() => void) | null>(null);

  /** Flags or unflags messages in 500-UID calls; the rows change at once. */
  const setFlagged = async (uids: number[], flagged: boolean) => {
    const back = patchLists(qc, filter.folder, uids, { flagged });
    try {
      for (let i = 0; i < uids.length; i += MAIL_BULK_CHUNK) {
        await api.call('mailUpdateFlags', {
          body: { folder: filter.folder, uids: uids.slice(i, i + MAIL_BULK_CHUNK), flagged },
          idempotencyKey: idempotencyKey(),
        });
      }
      void qc.invalidateQueries({ queryKey: ['mail', 'thread'] });
    } catch (e) {
      back();
      toast(mailError(t, e));
    }
  };

  /** Reply / forward needs the whole message: loaded (or taken from the cache) first. */
  const compose = async (mode: ComposeMode, uid: number) => {
    try {
      const thread = await qc.fetchQuery(mailThreadQuery(filter.folder, uid, false));
      const message =
        thread.items.find((m) => m.folder === filter.folder && m.uid === uid) ??
        thread.items.at(-1);
      if (message) onCompose(mode, message);
    } catch (e) {
      toast(mailError(t, e));
    }
  };

  /**
   * Right-click menu of a row: the selection when the row is in it (bulk), else the row's own
   * conversation.
   */
  const rowMenu = (row: ConversationRow): ActionEntry[] => {
    const inSelection = allInFolder || picked.has(rowKey(row));
    const group = inSelection ? (allInFolder ? rows : chosen) : [row];
    const anyUnread = group.some((r) => r.unread);
    const anyUnflagged = group.some((r) => !r.flagged);
    // Shift+I / Shift+U act on the selection, or on the open conversation when nothing is picked.
    const keysHere =
      inSelection || (!selecting && selected !== null && row.uids.includes(selected));
    const apply = (action: MailBulkAction, moveTo?: string) => {
      if (inSelection) {
        void run(action, moveTo);
        return;
      }
      if (action !== 'seen') onRemoved(row.uids);
      void bulk(filter.folder, action, { kind: 'uids', uids: row.uids }, moveTo).then((ok) => {
        if (ok && action === 'move') toast(t('mail.view.moved'));
        if (ok && action === 'delete') {
          toast(inTrash ? t('mail.view.deletedForever') : t('mail.view.deleted'));
        }
      });
    };
    const entries: ActionEntry[] = [];
    if (!inSelection) {
      const uid = row.latest.uid;
      entries.push(
        {
          kind: 'item',
          key: 'open',
          icon: 'mail',
          label: t('mail.menu.open'),
          onSelect: () => onSelect(uid),
        },
        {
          kind: 'item',
          key: 'newTab',
          icon: 'ext',
          label: t(newTabLabel()),
          onSelect: () => openInNewTab(messageHref(uid)),
        },
        {
          kind: 'item',
          key: 'reply',
          icon: 'reply',
          label: t('mail.view.reply'),
          onSelect: () => void compose('reply', uid),
        },
        {
          kind: 'item',
          key: 'replyAll',
          icon: 'reply',
          label: t('mail.view.replyAll'),
          onSelect: () => void compose('replyAll', uid),
        },
        {
          kind: 'item',
          key: 'forward',
          icon: 'arrowR',
          label: t('mail.view.forward'),
          onSelect: () => void compose('forward', uid),
        },
        { kind: 'sep', key: 's1' },
      );
    }
    entries.push(
      anyUnread
        ? {
            kind: 'item',
            key: 'seen',
            icon: 'checkC',
            label: t('mail.view.markRead'),
            shortcut: keysHere ? 'Shift I' : undefined,
            onSelect: () => apply('seen'),
          }
        : {
            kind: 'item',
            key: 'unseen',
            icon: 'eye',
            label: t('mail.view.markUnread'),
            shortcut: keysHere ? 'Shift U' : undefined,
            onSelect: () => apply('unseen'),
          },
    );
    // Flags are set per message: a folder-wide selection has no flag job.
    if (!allInFolder) {
      entries.push({
        kind: 'item',
        key: 'flag',
        icon: 'flag',
        label: anyUnflagged ? t('mail.view.flag') : t('mail.view.unflag'),
        onSelect: () =>
          void setFlagged(
            group.flatMap((r) => r.uids),
            anyUnflagged,
          ),
      });
    }
    if (targets.length) {
      entries.push({
        kind: 'sub',
        key: 'move',
        icon: 'folder',
        label: t('mail.view.moveTo'),
        items: targets.map((f) => ({
          key: f.path,
          label: folderLabel(f, t),
          onSelect: () => apply('move', f.path),
        })),
      });
    }
    entries.push(
      { kind: 'sep', key: 's2' },
      {
        kind: 'item',
        key: 'delete',
        icon: 'trash',
        label: inTrash ? t('mail.view.deleteForever') : t('mail.view.delete'),
        danger: true,
        onSelect: () => (inTrash ? setPurge(() => () => apply('delete')) : apply('delete')),
      },
    );
    return entries;
  };

  return (
    <ResizablePane id="mail-list" side="left" defaultWidth={340} className="max-md:w-full">
      <section
        aria-label={t('mail.list.label')}
        onKeyDown={onListKey}
        className="flex min-h-0 w-full min-w-0 flex-col border-line md:border-r"
      >
        <div className="flex shrink-0 flex-col gap-2 border-b border-line p-3">
          <div className="relative">
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg3"
            />
            <Input
              type="search"
              aria-label={t('mail.search.label')}
              placeholder={t('mail.search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
            {query ? (
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('mail.search.clear')}
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
                onClick={() => {
                  setQuery('');
                  onFilter({ q: undefined });
                }}
              >
                <Icon name="x" size={14} />
              </IconButton>
            ) : null}
          </div>
          {selecting ? (
            <div
              role="toolbar"
              aria-label={t('mail.select.bar')}
              className="flex min-h-9 flex-wrap items-center gap-1"
            >
              <Checkbox
                aria-label={t('mail.select.page')}
                checked={chosen.length === rows.length || allInFolder ? true : 'indeterminate'}
                onCheckedChange={(v) => (v === true ? pickAll() : clear())}
                className="mx-1"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {allInFolder
                  ? t('mail.select.folderCount', { total: num(folderTotal) })
                  : t('mail.select.count', { count: chosen.length })}
              </span>
              <Tooltip content={t('mail.bulk.markRead')}>
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('mail.bulk.markRead')}
                  onClick={() => void run('seen')}
                >
                  <Icon name="checkC" size={18} />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('mail.bulk.markUnread')}>
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('mail.bulk.markUnread')}
                  onClick={() => void run('unseen')}
                >
                  <Icon name="mail" size={18} />
                </IconButton>
              </Tooltip>
              {targets.length ? (
                <Menu>
                  <MenuTrigger asChild>
                    <IconButton size="sm" tone="plain" aria-label={t('mail.view.moveTo')}>
                      <Icon name="folder" size={18} />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent align="end">
                    {targets.map((f) => (
                      <MenuItem
                        key={f.path}
                        icon="folder"
                        onSelect={() => void run('move', f.path)}
                      >
                        {folderLabel(f, t)}
                      </MenuItem>
                    ))}
                  </MenuContent>
                </Menu>
              ) : null}
              <Tooltip content={t('mail.view.delete')}>
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('mail.view.delete')}
                  onClick={() => void run('delete')}
                >
                  <Icon name="trash" size={18} />
                </IconButton>
              </Tooltip>
              <IconButton
                size="sm"
                tone="plain"
                aria-label={t('mail.select.clear')}
                onClick={clear}
              >
                <Icon name="x" size={18} />
              </IconButton>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Segmented
                aria-label={t('mail.filter.label')}
                value={filter.filter}
                onValueChange={(v) => onFilter({ filter: v })}
                className="flex-1"
                options={[
                  { value: 'all', label: t('mail.filter.all') },
                  { value: 'unread', label: t('mail.filter.unread') },
                  { value: 'flagged', label: t('mail.filter.flagged') },
                ]}
              />
              <Tooltip content={t('mail.bulk.markAllRead')}>
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('mail.bulk.markAllRead')}
                  disabled={!folder?.unread}
                  onClick={() => void bulk(filter.folder, 'seen', { kind: 'folder' })}
                >
                  <Icon name="checkC" size={18} />
                </IconButton>
              </Tooltip>
            </div>
          )}
          {canPickFolder || allInFolder ? (
            <div className="flex flex-wrap items-center gap-x-2 rounded-md bg-bg2 px-2.5 py-1.5 text-xs text-fg2">
              <span>
                {allInFolder
                  ? t('mail.select.folderSelected', { total: num(folderTotal) })
                  : t('mail.select.pageSelected', { count: chosen.length })}
              </span>
              <button
                type="button"
                className="font-semibold text-fg underline-offset-2 hover:underline"
                onClick={() => (allInFolder ? clear() : setAllInFolder(true))}
              >
                {allInFolder
                  ? t('mail.select.clear')
                  : t('mail.select.pickFolder', { total: num(folderTotal) })}
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {list.isPending ? (
            slow ? (
              Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mx-3 my-2 h-14" />)
            ) : null
          ) : list.isError ? (
            <EmptyState icon="alert" title={mailError(t, list.error)}>
              {isAuthProblem(list.error) ? (
                <Button asChild size="sm" variant="pri">
                  <Link to="/mail/settings">{t('mail.connect.reconnect')}</Link>
                </Button>
              ) : (
                <Button size="sm" onClick={() => void list.refetch()}>
                  {t('mail.connect.retry')}
                </Button>
              )}
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState
              icon="inbox"
              title={
                filter.q
                  ? t('mail.list.emptySearch')
                  : filter.filter !== 'all'
                    ? t('mail.list.emptyFilter')
                    : t('mail.list.empty')
              }
            />
          ) : (
            // Only the rows in view are rendered: a folder scrolled to 2 000 messages stays light.
            <VirtualList
              items={rows}
              rowHeight={ROW_HEIGHT}
              getKey={(row) => `${row.latest.threadId}:${row.latest.uid}`}
              activeIndex={activeIndex}
              className="m-0 list-none p-0"
              renderRow={(row, index) => (
                <Row
                  row={row}
                  active={row.latest.uid === selected}
                  picked={allInFolder || picked.has(rowKey(row))}
                  selecting={selecting}
                  onPick={(e) => toggle(index, e)}
                  onSelect={() => onSelect(row.latest.uid)}
                  menu={rowMenu(row)}
                  onHover={(on) => {
                    if (hover.current) clearTimeout(hover.current);
                    hover.current = on ? setTimeout(() => prefetch(row.latest.uid), 120) : null;
                  }}
                  me={me}
                  sentFolder={folder?.specialUse === 'sent'}
                  time={row.latest.date ? formatRelative(row.latest.date, locale) : ''}
                />
              )}
              footer={
                list.hasNextPage ? (
                  <LoadMore
                    loading={list.isFetchingNextPage}
                    onLoad={() => void list.fetchNextPage()}
                  />
                ) : null
              }
            />
          )}
        </div>
        <ConfirmDialog
          open={purge !== null}
          onOpenChange={(v) => !v && setPurge(null)}
          title={t('mail.view.deleteForever')}
          body={t('mail.view.deleteForeverBody')}
          confirm={t('mail.view.deleteForever')}
          onConfirm={() => {
            purge?.();
            setPurge(null);
          }}
        />
      </section>
    </ResizablePane>
  );
}

function Row({
  row,
  active,
  picked,
  selecting,
  onPick,
  onSelect,
  menu,
  onHover,
  me,
  sentFolder,
  time,
}: {
  row: ConversationRow;
  active: boolean;
  picked: boolean;
  selecting: boolean;
  onPick: (e: MouseEvent) => void;
  onSelect: () => void;
  menu: ActionEntry[];
  onHover: (on: boolean) => void;
  me: string;
  sentFolder: boolean;
  time: string;
}) {
  const { t } = useI18n();
  const m = row.latest;
  const fromMe = m.from ? sameAddress(m.from.address, me) : false;
  const who =
    sentFolder || fromMe
      ? t('mail.list.to', {
          names: m.to.map((a) => a.name || a.address).join(', ') || t('mail.list.unknownSender'),
        })
      : m.from?.name || m.from?.address || t('mail.list.unknownSender');
  const subject = m.subject || t('mail.list.noSubject');
  return (
    <ActionContextMenu entries={menu}>
      <div
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        className={cn(
          'group flex h-full items-start overflow-hidden border-b border-line hover:bg-bg2',
          active && 'bg-capsule hover:bg-capsule',
          picked && 'bg-accent10 hover:bg-accent10',
        )}
      >
        <span className="flex shrink-0 items-center self-stretch pl-3">
          <Checkbox
            aria-label={t('mail.select.row', { title: subject })}
            checked={picked}
            onClick={(e) => {
              e.preventDefault();
              onPick(e);
            }}
            className={cn(
              'transition-opacity',
              !selecting &&
                'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100',
            )}
          />
        </span>
        <button
          type="button"
          data-mail-row={m.uid}
          onClick={(e) => (selecting || e.shiftKey ? onPick(e) : onSelect())}
          {...middleClickOpens(() => messageHref(m.uid))}
          aria-current={active ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-left"
        >
          <Avatar name={m.from?.name || m.from?.address || '?'} size="md" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-sm',
                  row.unread ? 'font-bold' : 'font-medium text-fg2',
                )}
              >
                {who}
                {row.count > 1 ? (
                  <span className="ml-1.5 text-xs font-medium text-fg3">
                    {t('mail.list.conversation', { count: row.count })}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-fg3 tn">{time}</span>
            </span>
            <span className="flex items-center gap-1.5">
              {row.unread ? (
                <span
                  role="img"
                  aria-label={t('mail.list.unread')}
                  className="size-2 shrink-0 rounded-full bg-accent"
                />
              ) : null}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[13px]',
                  row.unread ? 'font-semibold text-fg' : 'text-fg2',
                )}
              >
                {subject}
              </span>
              {row.hasAttachments ? (
                <Icon
                  name="clip"
                  size={14}
                  className="shrink-0 text-fg3"
                  aria-label={t('mail.list.attachment')}
                />
              ) : null}
              {row.flagged ? (
                <Icon
                  name="flag"
                  size={14}
                  className="shrink-0 text-warning"
                  aria-label={t('mail.list.flagged')}
                />
              ) : null}
            </span>
          </span>
        </button>
      </div>
    </ActionContextMenu>
  );
}

/** Height of a list row; fixed so the list can be windowed. */
const ROW_HEIGHT = 66;

/** "Load more" at the end of the list; also loads by itself when it scrolls into view. */
export function LoadMore({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLLIElement>(null);
  const load = useRef(onLoad);
  useEffect(() => {
    load.current = onLoad;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) load.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <li ref={ref} className="flex justify-center p-3">
      <Button size="sm" variant="gh" loading={loading} onClick={onLoad}>
        {t('mail.list.loadMore')}
      </Button>
    </li>
  );
}
