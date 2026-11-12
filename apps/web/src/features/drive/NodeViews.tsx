import { type DriveNode } from '@crewhall/shared';
import { Avatar, Checkbox, cn, Icon, IconButton, SelectAllCheckbox, Tooltip } from '@crewhall/ui';
import {
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  ActionContextMenu,
  ActionDropdown,
  type ActionEntry,
} from '@/components/common/ActionMenu';
import { formatBytes, formatDate, formatRelative } from '@/lib/i18n/format';
import { useI18n, type WebKey } from '@/lib/i18n/I18nContext';
import { middleClickOpens } from '@/lib/newTab';
import { type NodeSort } from './api';
import { draggedNodes, endNodeDrag, isNodeDrag, startNodeDrag } from './dnd';
import { badgeOf, kindOf, nodeIcon } from './fileKinds';
import { rawPreviewUrl } from './urls';
import { useShellLayout } from '@/lib/shell';

export interface ViewProps {
  nodes: DriveNode[];
  selected: Set<string>;
  onSelect: (node: DriveNode, e: { ctrl: boolean; shift: boolean }) => void;
  onToggle: (node: DriveNode) => void;
  /** Header box: select every shown node, or clear. */
  onSelectAll: (all: boolean) => void;
  onOpen: (node: DriveNode) => void;
  onFavorite: (node: DriveNode) => void;
  /** Where the node opens: the name is a real link, the middle button opens a new tab. */
  href: (node: DriveNode) => string;
  menu: (nodes: DriveNode[]) => ActionEntry[];
  /** Nodes the menu acts on when a row is right-clicked (the selection if it includes it). */
  menuTargets: (node: DriveNode) => DriveNode[];
  /** Drag to move into folders; absent = rows are not draggable. */
  dnd?: NodeDnd;
}

/**
 * The name as a link, for the browser's own ways of opening one; a plain click stays the row's
 * (select, double click opens) and a drag starting on it moves the row.
 */
function NodeName({ href, name, className }: { href: string; name: string; className: string }) {
  return (
    <a
      href={href}
      draggable={false}
      tabIndex={-1}
      onClick={(e) => e.preventDefault()}
      className={cn('text-inherit no-underline', className)}
    >
      {name}
    </a>
  );
}

export interface NodeDnd {
  /** What a drag starting on `node` carries (the selection when it holds the node); [] = no drag. */
  dragNodes: (node: DriveNode) => DriveNode[];
  /** Rights and no-op/cycle checks for dropping `nodes` into the folder `target`. */
  canDrop: (target: DriveNode, nodes: DriveNode[]) => boolean;
  onDrop: (target: DriveNode, nodes: DriveNode[]) => void;
}

/** Drag handlers for list rows and grid tiles: any row drags, folders take the drop. */
function useNodeDrag(dnd: NodeDnd | undefined) {
  const [overId, setOverId] = useState<string | null>(null);
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const end = () => {
    endNodeDrag();
    setOverId(null);
    setMoving(new Set());
  };
  const props = (n: DriveNode) =>
    dnd
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            const nodes = dnd.dragNodes(n);
            if (nodes.length === 0) return e.preventDefault();
            startNodeDrag(e, nodes);
            setMoving(new Set(nodes.map((x) => x.id)));
          },
          onDragEnd: end,
          onDragOver: (e: DragEvent) => {
            if (n.type !== 'folder' || !isNodeDrag(e) || !dnd.canDrop(n, draggedNodes())) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setOverId(n.id);
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setOverId((id) => (id === n.id ? null : id));
            }
          },
          onDrop: (e: DragEvent) => {
            const nodes = draggedNodes();
            if (n.type !== 'folder' || !isNodeDrag(e) || !dnd.canDrop(n, nodes)) return;
            e.preventDefault();
            e.stopPropagation();
            dnd.onDrop(n, nodes);
            end();
          },
        }
      : {};
  return {
    props,
    over: (n: DriveNode) => overId === n.id,
    moving: (n: DriveNode) => moving.has(n.id),
  };
}

export function typeLabel(n: DriveNode, t: (k: WebKey) => string): string {
  if (n.type !== 'file') return t(`drive.types.${n.type}`);
  return t(`drive.kinds.${kindOf(n.name, n.mime)}` as WebKey);
}

/** Recent edits as "bugün 09:20", older ones as a date (3.4). */
export function when(iso: string, locale: 'tr' | 'en'): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  return days < 2
    ? formatRelative(d, locale)
    : formatDate(d, locale, { day: 'numeric', month: 'short' });
}

function pick(e: MouseEvent | KeyboardEvent) {
  return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
}

export function NodeIconBox({ node, size = 'md' }: { node: DriveNode; size?: 'sm' | 'md' | 'lg' }) {
  const badge = node.type === 'file' ? badgeOf(node.name) : '';
  const box = {
    sm: 'h-6 min-w-6 rounded-[6px] text-[9px]',
    md: 'h-8 min-w-8 rounded-[8px] text-[10px]',
    lg: 'h-14 min-w-14 rounded-[12px] text-xs',
  }[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center bg-bg2 px-1 font-bold text-fg2',
        box,
      )}
    >
      {node.type === 'file' && badge ? (
        badge
      ) : (
        <Icon name={nodeIcon(node)} size={size === 'lg' ? 26 : size === 'md' ? 17 : 14} />
      )}
    </span>
  );
}

export function NodeTable({
  sort,
  order,
  onSort,
  ...p
}: ViewProps & { sort: NodeSort; order: 'asc' | 'desc'; onSort: (s: NodeSort) => void }) {
  const { t, locale } = useI18n();
  const drag = useNodeDrag(p.dnd);
  const phone = useShellLayout() === 'phone';
  const head = (key: NodeSort | null, label: string, className?: string) => (
    <th
      scope="col"
      className={cn('h-9 px-3 text-left text-xs font-semibold text-fg2', className)}
      aria-sort={key && sort === key ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      {key ? (
        <button
          type="button"
          onClick={() => onSort(key)}
          className="flex items-center gap-1 hover:text-fg"
        >
          {label}
          {sort === key ? <Icon name={order === 'asc' ? 'chevU' : 'chevD'} size={12} /> : null}
        </button>
      ) : (
        label
      )}
    </th>
  );
  return (
    // Narrow screens (H10): the table scrolls sideways in its own box, not the whole page.
    <div className="overflow-x-auto">
      <table
        className="group/table w-full border-separate border-spacing-0"
        aria-label={t('drive.list.label')}
        aria-multiselectable="true"
      >
        <thead>
          <tr>
            <th className="w-9 pl-2 text-left">
              {p.nodes.length ? (
                <SelectAllCheckbox
                  state={
                    p.selected.size === 0
                      ? 'none'
                      : p.nodes.every((n) => p.selected.has(n.id))
                        ? 'all'
                        : 'some'
                  }
                  onChange={(all) => p.onSelectAll(all)}
                  label={t('ui.selectAll')}
                  className={cn(
                    p.selected.size === 0 &&
                      'opacity-0 group-hover/table:opacity-100 focus-visible:opacity-100',
                  )}
                />
              ) : null}
            </th>
            {head('name', t('drive.list.name'))}
            {/* Phone (W7): a list, not a table; the name cell carries a summary line. */}
            {head('type', t('drive.list.type'), 'w-[150px] max-md:hidden')}
            {head(null, t('drive.list.owner'), 'w-[140px] max-md:hidden')}
            {head('updatedAt', t('drive.list.updated'), 'w-[130px] max-md:hidden')}
            {head('size', t('drive.list.size'), 'w-[100px] text-right max-md:hidden')}
            <th className="w-[76px]" />
          </tr>
        </thead>
        <tbody>
          {p.nodes.map((n) => {
            const on = p.selected.has(n.id);
            return (
              <ActionContextMenu key={n.id} entries={p.menu(p.menuTargets(n))}>
                <tr
                  aria-selected={on}
                  tabIndex={0}
                  data-node-id={n.id}
                  data-drop-target={drag.over(n) || undefined}
                  {...drag.props(n)}
                  {...middleClickOpens(() => p.href(n))}
                  // Touch has no double click: a tap opens unless the user is selecting.
                  onClick={(e) =>
                    phone && p.selected.size === 0 ? p.onOpen(n) : p.onSelect(n, pick(e))
                  }
                  onDoubleClick={() => p.onOpen(n)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') p.onOpen(n);
                  }}
                  className={cn(
                    'group/row h-12 cursor-default outline-none max-md:h-14 [&>td]:border-b [&>td]:border-line',
                    on ? '[&>td]:bg-capsule' : 'hover:[&>td]:bg-bg2 focus-visible:[&>td]:bg-bg2',
                    drag.over(n) &&
                      '[&>td]:bg-capsule [&>td]:shadow-[inset_0_1.5px_0_var(--fg),inset_0_-1.5px_0_var(--fg)] [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md',
                    drag.moving(n) && 'opacity-50',
                  )}
                >
                  <td className="pl-2">
                    <Checkbox
                      checked={on}
                      aria-label={t('drive.list.select', { name: n.name })}
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={() => p.onToggle(n)}
                      className={cn(
                        !on &&
                          p.selected.size === 0 &&
                          'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                      )}
                    />
                  </td>
                  <td className="px-3">
                    <span className="flex min-w-0 items-center gap-3">
                      <NodeIconBox node={n} />
                      <span className="flex min-w-0 flex-col">
                        <NodeName
                          href={p.href(n)}
                          name={n.name}
                          className="min-w-0 truncate text-sm font-semibold"
                        />
                        {phone ? (
                          <span className="truncate text-xs text-fg2 tn">
                            {[
                              typeLabel(n, t),
                              when(n.updatedAt, locale),
                              n.type === 'file' ? formatBytes(n.sizeBytes, locale) : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        ) : null}
                      </span>
                      {n.shared ? (
                        <Tooltip content={t('drive.list.shared')}>
                          <span
                            className="flex text-fg3"
                            aria-label={t('drive.list.shared')}
                            role="img"
                          >
                            <Icon name="lock" size={13} />
                          </span>
                        </Tooltip>
                      ) : null}
                      {n.preview === 'pending' ? (
                        <span className="text-[11px] text-fg3">{t('drive.list.processing')}</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-3 text-cap text-fg2 max-md:hidden">{typeLabel(n, t)}</td>
                  <td className="px-3 max-md:hidden">
                    {n.createdBy ? (
                      <span className="flex items-center gap-2 text-cap">
                        <Avatar name={n.createdBy.name} size="sm" src={n.createdBy.imageUrl} />
                        <span className="truncate">{n.createdBy.name.split(' ')[0]}</span>
                      </span>
                    ) : (
                      <span className="text-cap text-fg3">{t('drive.list.system')}</span>
                    )}
                  </td>
                  <td className="px-3 text-cap text-fg2 tn max-md:hidden">
                    {when(n.updatedAt, locale)}
                  </td>
                  <td className="px-3 text-right text-cap text-fg2 tn max-md:hidden">
                    {n.type === 'file' ? formatBytes(n.sizeBytes, locale) : '—'}
                  </td>
                  <td className="pr-2">
                    <RowTools
                      node={n}
                      entries={p.menu(p.menuTargets(n))}
                      onFavorite={p.onFavorite}
                    />
                  </td>
                </tr>
              </ActionContextMenu>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowTools({
  node,
  entries,
  onFavorite,
}: {
  node: DriveNode;
  entries: ActionEntry[];
  onFavorite: (n: DriveNode) => void;
}) {
  const { t } = useI18n();
  return (
    <span
      className="flex items-center justify-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <IconButton
        size="xs"
        tone="plain"
        aria-label={node.favorite ? t('drive.menu.unfavorite') : t('drive.menu.favorite')}
        aria-pressed={node.favorite}
        onClick={() => onFavorite(node)}
        className={cn(
          !node.favorite && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
          node.favorite && 'text-accent-text',
        )}
      >
        <Icon name="star" size={15} fill={node.favorite ? 'currentColor' : 'none'} />
      </IconButton>
      <ActionDropdown entries={entries}>
        <IconButton size="xs" tone="plain" aria-label={t('drive.list.more', { name: node.name })}>
          <Icon name="dots" size={16} />
        </IconButton>
      </ActionDropdown>
    </span>
  );
}

export function NodeGrid(p: ViewProps) {
  const { t, locale } = useI18n();
  const drag = useNodeDrag(p.dnd);
  return (
    <div
      role="listbox"
      aria-label={t('drive.list.label')}
      aria-multiselectable="true"
      className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5"
    >
      {p.nodes.map((n) => {
        const on = p.selected.has(n.id);
        return (
          <ActionContextMenu key={n.id} entries={p.menu(p.menuTargets(n))}>
            <div
              role="option"
              aria-selected={on}
              tabIndex={0}
              data-node-id={n.id}
              data-drop-target={drag.over(n) || undefined}
              {...drag.props(n)}
              {...middleClickOpens(() => p.href(n))}
              onClick={(e) => p.onSelect(n, pick(e))}
              onDoubleClick={() => p.onOpen(n)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') p.onOpen(n);
              }}
              className={cn(
                'group/row relative flex cursor-default flex-col overflow-hidden rounded-xl bg-surface outline-none',
                on || drag.over(n)
                  ? 'shadow-[inset_0_0_0_2px_var(--fg)]'
                  : 'shadow-line hover:shadow-line2 focus-visible:shadow-line2',
                drag.over(n) && 'bg-capsule',
                drag.moving(n) && 'opacity-50',
              )}
            >
              <Thumb node={n}>
                <Checkbox
                  checked={on}
                  aria-label={t('drive.list.select', { name: n.name })}
                  onClick={(e) => e.stopPropagation()}
                  onCheckedChange={() => p.onToggle(n)}
                  className={cn(
                    'absolute top-2 left-2 bg-surface',
                    !on && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                  )}
                />
              </Thumb>
              <span className="flex min-w-0 flex-col px-3 py-2.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <NodeName
                    href={p.href(n)}
                    name={n.name}
                    className="min-w-0 flex-1 truncate text-cap font-semibold"
                  />
                  {n.favorite ? (
                    <Icon
                      name="star"
                      size={13}
                      className="shrink-0 text-accent-text"
                      fill="currentColor"
                    />
                  ) : null}
                  {n.shared ? <Icon name="lock" size={12} className="shrink-0 text-fg3" /> : null}
                </span>
                <span className="truncate text-[11.5px] text-fg3">
                  {n.type === 'file'
                    ? `${formatBytes(n.sizeBytes, locale)}${n.preview === 'failed' ? ` · ${t('drive.list.noPreview')}` : ''}`
                    : n.type === 'folder'
                      ? n.hasChildren
                        ? t('drive.types.folder')
                        : t('drive.list.empty')
                      : `${typeLabel(n, t)} · ${n.createdBy?.name.split(' ')[0] ?? ''}`}
                </span>
              </span>
            </div>
          </ActionContextMenu>
        );
      })}
    </div>
  );
}

function Thumb({ node, children }: { node: DriveNode; children: ReactNode }) {
  return (
    <span className="relative flex h-[118px] items-center justify-center overflow-hidden bg-bg2">
      {(node.type === 'file' || node.type === 'drawing') && node.preview === 'ready' ? (
        <img
          src={rawPreviewUrl(
            node.id,
            'thumb_256',
            node.version ?? (node.type === 'drawing' ? Date.parse(node.updatedAt) : undefined),
          )}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <NodeIconBox node={node} size="lg" />
      )}
      {children}
    </span>
  );
}
