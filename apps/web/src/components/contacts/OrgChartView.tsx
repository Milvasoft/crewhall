import { type OrgChart, type OrgChartNode } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Segmented,
  Skeleton,
  toast,
  Tooltip,
} from '@crewhall/ui';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { contactsKeys, orgChartQuery } from '@/lib/contacts/queries';
import {
  chartIsFlat,
  chartModel,
  chartSvg,
  descendantsOf,
  downloadChart,
  exportRows,
  type ChartGroup,
  type ChartModel,
} from '@/lib/contacts/chart';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { usePersonEntries } from './ContactMenus';
import { DirectoryTable } from './DirectoryTable';
import { ImportDirectoryDialog } from './ImportDirectoryDialog';

const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
const ROOT = 'to:root';

/**
 * Org chart (roadmap 15, sonraki-isler): the manager line as a tree, or grouped by department
 * or team; a table for bulk edits and a CSV import. Org admins move people by dragging them onto
 * their new manager (never under themselves); a manager synced from AD/LDAP or Google Workspace
 * stays where it is. Zoom, PNG and PDF export.
 */
export function OrgChartView({
  q,
  selected,
  onSelect,
}: {
  q: string;
  selected: string | null;
  onSelect: (userId: string) => void;
}) {
  const { t } = useI18n();
  const chart = useQuery(orgChartQuery());
  const items = useMemo(() => chart.data?.items ?? [], [chart.data]);
  const admin = chart.data?.permissions?.editManager ?? false;
  const [mode, setMode] = useState<'tree' | 'table'>('tree');
  const [group, setGroup] = useState<ChartGroup>('manager');
  const [zoom, setZoom] = useState(1);
  const [importing, setImporting] = useState(false);
  const model = useMemo(() => chartModel(items, group), [items, group]);

  if (chart.isLoading) return <Skeleton className="h-40" />;
  if (!items.length) {
    return (
      <EmptyState
        icon="layers"
        title={t('contacts.chart.emptyTitle')}
        description={t('contacts.chart.empty')}
      />
    );
  }

  const zoomAt = ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
  const exportAs = (kind: 'png' | 'pdf') => {
    const title = t('contacts.nav.chart');
    void downloadChart(
      kind,
      chartSvg(exportRows(model, t('contacts.chart.group.none')), title),
      t('contacts.chart.fileName'),
    );
  };

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="org-chart-view">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          aria-label={t('contacts.chart.view.label')}
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'tree', label: t('contacts.chart.view.tree') },
            { value: 'table', label: t('contacts.chart.view.table') },
          ]}
        />
        {mode === 'tree' ? (
          <>
            <Segmented
              size="sm"
              aria-label={t('contacts.chart.group.label')}
              value={group}
              onValueChange={setGroup}
              options={(['manager', 'department', 'team'] as const).map((g) => ({
                value: g,
                label: t(`contacts.chart.group.${g}`),
              }))}
            />
            <div className="flex items-center gap-0.5 rounded-lg border border-line px-0.5">
              <Tooltip content={t('contacts.chart.zoomOut')}>
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label={t('contacts.chart.zoomOut')}
                  disabled={zoomAt <= 0}
                  onClick={() => setZoom(ZOOMS[Math.max(0, zoomAt - 1)]!)}
                >
                  <Icon name="minus" size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('contacts.chart.zoomReset')}>
                <button
                  type="button"
                  onClick={() => setZoom(1)}
                  className="min-w-12 rounded px-1 text-xs font-semibold tabular-nums hover:bg-bg2"
                  aria-label={t('contacts.chart.zoomReset')}
                >
                  {t('contacts.chart.zoom', { count: Math.round(zoom * 100) })}
                </button>
              </Tooltip>
              <Tooltip content={t('contacts.chart.zoomIn')}>
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label={t('contacts.chart.zoomIn')}
                  disabled={zoomAt >= ZOOMS.length - 1}
                  onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomAt + 1)]!)}
                >
                  <Icon name="plus" size={14} />
                </IconButton>
              </Tooltip>
            </div>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {admin ? (
            <Button size="sm" variant="out" onClick={() => setImporting(true)}>
              <Icon name="upload" size={15} />
              {t('contacts.chart.importCsv')}
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant="out">
                <Icon name="download" size={15} />
                {t('contacts.chart.export')}
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon="image" onSelect={() => exportAs('png')}>
                {t('contacts.chart.png')}
              </MenuItem>
              <MenuItem icon="file" onSelect={() => exportAs('pdf')}>
                {t('contacts.chart.pdf')}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>

      {chartIsFlat(items) ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl bg-bg2 p-4"
          data-testid="org-chart-flat"
        >
          <Icon name="layers" size={20} className="text-fg2" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-semibold">{t('contacts.chart.flatTitle')}</span>
            <span className="text-xs text-fg2">
              {admin ? t('contacts.chart.flat') : t('contacts.chart.flatMember')}
            </span>
          </div>
          {admin && mode === 'tree' ? (
            <Button size="sm" variant="pri" onClick={() => setMode('table')}>
              {t('contacts.chart.assign')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === 'table' ? (
        <DirectoryTable items={items} q={q} admin={admin} onSelect={onSelect} />
      ) : (
        <ChartTree
          items={items}
          model={model}
          q={q}
          zoom={zoom}
          admin={admin}
          selected={selected}
          onSelect={onSelect}
        />
      )}
      {importing ? (
        <ImportDirectoryDialog onClose={() => setImporting(false)} items={items} />
      ) : null}
    </div>
  );
}

/** Moving a person: the chart changes at once, rolls back on an error, and offers undo. */
export function useMoveManager() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const key = contactsKeys.chart();
  const move = useMutation({
    mutationFn: (v: { userId: string; managerId: string | null }) =>
      api.call('updateDirectoryProfile', {
        params: { userId: v.userId },
        body: { managerId: v.managerId },
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<OrgChart>(key);
      qc.setQueryData<OrgChart>(key, (d) =>
        d
          ? {
              ...d,
              items: d.items.map((n) =>
                n.user.id === v.userId ? { ...n, managerId: v.managerId } : n,
              ),
            }
          : d,
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(key, ctx?.prev);
      toast(t(errorKey(e)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: contactsKeys.all }),
  });
  return (n: OrgChartNode, managerId: string | null, manager?: OrgChartNode) => {
    const before = n.managerId;
    move.mutate(
      { userId: n.user.id, managerId },
      {
        onSuccess: () =>
          toast(
            manager
              ? t('contacts.chart.moved', { name: n.user.name, person: manager.user.name })
              : t('contacts.chart.movedTop', { name: n.user.name }),
            {
              action: {
                label: t('contacts.chart.undo'),
                onClick: () => move.mutate({ userId: n.user.id, managerId: before }),
              },
            },
          ),
      },
    );
  };
}

function ChartTree({
  items,
  model,
  q,
  zoom,
  admin,
  selected,
  onSelect,
}: {
  items: OrgChartNode[];
  model: ChartModel;
  q: string;
  zoom: number;
  admin: boolean;
  selected: string | null;
  onSelect: (userId: string) => void;
}) {
  const { t } = useI18n();
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState<OrgChartNode | null>(null);
  const justDragged = useRef(false);
  const moveManager = useMoveManager();
  const menu = usePersonEntries();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
  );
  // Nobody can go under themselves or their own reports.
  const blocked = useMemo(
    () => (dragging ? descendantsOf(items, dragging.user.id) : new Set<string>()),
    [dragging, items],
  );

  // People matching the search, and every manager above them (to open the path).
  const term = q.trim().toLocaleLowerCase('tr');
  const { matches, path } = useMemo(() => {
    const matches = new Set<string>();
    const path = new Set<string>();
    if (!term) return { matches, path };
    for (const n of items) {
      const hay =
        `${n.user.name} ${n.title ?? ''} ${n.department ?? ''} ${n.team ?? ''}`.toLocaleLowerCase(
          'tr',
        );
      if (!hay.includes(term)) continue;
      matches.add(n.user.id);
      let up = n.managerId;
      for (let i = 0; up && i < 100; i++) {
        path.add(up);
        up = model.byId.get(up)?.managerId ?? null;
      }
    }
    return { matches, path };
  }, [items, term, model]);

  const isOpen = (id: string, depth: number) => toggled[id] ?? (path.has(id) || depth < 1);

  const onDragStart = (e: DragStartEvent) => {
    justDragged.current = true;
    setDragging(model.byId.get(String(e.active.id)) ?? null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const n = dragging;
    setDragging(null);
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    const over = e.over ? String(e.over.id) : null;
    if (!n || !over) return;
    if (over === ROOT) {
      if (n.managerId) moveManager(n, null);
      return;
    }
    const managerId = over.slice('to:'.length);
    if (managerId === n.managerId || blocked.has(managerId)) return;
    moveManager(n, managerId, model.byId.get(managerId));
  };

  const render = (n: OrgChartNode, depth: number): ReactNode => {
    const kids = model.childrenOf(n.user.id);
    const open = isOpen(n.user.id, depth);
    return (
      <li key={n.user.id} className="relative">
        <div className="flex items-center gap-1.5">
          {kids.length ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={t(open ? 'contacts.chart.collapse' : 'contacts.chart.expand', {
                name: n.user.name,
              })}
              onClick={() => setToggled((s) => ({ ...s, [n.user.id]: !open }))}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg2 hover:bg-bg2"
            >
              <Icon name={open ? 'chevD' : 'chevR'} size={14} />
            </button>
          ) : (
            <span className="size-6 shrink-0" />
          )}
          <PersonRow
            n={n}
            movable={admin && !n.managerSynced}
            dropDisabled={!dragging || blocked.has(n.user.id) || dragging.managerId === n.user.id}
            selected={selected === n.user.id}
            match={matches.has(n.user.id)}
            lifted={dragging?.user.id === n.user.id}
            entries={menu(n)}
            onSelect={() => {
              if (!justDragged.current) onSelect(n.user.id);
            }}
          />
        </div>
        {kids.length && open ? (
          <ul className="m-0 ml-3 list-none border-l border-line pl-4">
            {kids.map((k) => render(k, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  const grouped = model.sections.length > 1 || model.sections[0]?.key !== null;
  return (
    <DndContext
      sensors={sensors}
      // The row under the pointer is the new manager (rows are long and narrow).
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(null);
        justDragged.current = false;
      }}
    >
      {admin ? <p className="text-xs text-fg3">{t('contacts.chart.dragHint')}</p> : null}
      {dragging?.managerId ? <RootZone label={t('contacts.chart.top')} /> : null}
      <div className="min-h-0 overflow-auto" data-testid="org-chart">
        <div style={{ zoom }} className="origin-top-left">
          {model.sections.map((s) => (
            <section key={s.key ?? '-'} className="mb-4 flex flex-col gap-1">
              {grouped ? (
                <h3 className="eyebrow flex items-center gap-2 px-1 pb-1">
                  {s.key ?? t('contacts.chart.group.none')}
                  <span className="text-fg3">{s.size}</span>
                </h3>
              ) : null}
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {s.roots.map((r) => render(r, 0))}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(.34,1.36,.5,1)' }}>
        {dragging ? (
          <div className="flex w-[300px] scale-[1.03] items-center gap-2.5 rounded-xl bg-surface px-3 py-2 shadow-xl ring-2 ring-accent">
            <Avatar name={dragging.user.name} src={dragging.user.imageUrl} size="sm" />
            <span className="truncate text-sm font-semibold">{dragging.user.name}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function RootZone({ label }: { label: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: ROOT });
  return (
    <div
      ref={setNodeRef}
      data-testid="org-chart-root"
      className={cn(
        'rounded-xl border-2 border-dashed border-line px-4 py-3 text-center text-sm text-fg2 transition-colors',
        isOver && 'border-accent bg-accent10',
      )}
    >
      {label}
    </div>
  );
}

function PersonRow({
  n,
  movable,
  dropDisabled,
  selected,
  match,
  lifted,
  entries,
  onSelect,
}: {
  n: OrgChartNode;
  /** The person's right-click menu. */
  entries: ActionEntry[];
  movable: boolean;
  dropDisabled: boolean;
  selected: boolean;
  match: boolean;
  lifted: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const drag = useDraggable({ id: n.user.id, disabled: !movable });
  const drop = useDroppable({ id: `to:${n.user.id}`, disabled: dropDisabled });
  return (
    <ActionContextMenu entries={entries}>
      <button
        type="button"
        ref={(el) => {
          drag.setNodeRef(el);
          drop.setNodeRef(el);
        }}
        {...(movable ? drag.listeners : {})}
        data-person={n.user.id}
        onClick={onSelect}
        aria-pressed={selected}
        aria-description={
          movable
            ? t('contacts.chart.dragHint')
            : n.managerSynced
              ? t('contacts.chart.synced')
              : undefined
        }
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-[opacity,box-shadow,background-color] hover:bg-bg2 sm:max-w-[420px]',
          movable && 'cursor-grab touch-manipulation',
          selected && 'bg-capsule',
          match && 'shadow-[inset_0_0_0_2px_var(--accent)]',
          lifted && 'opacity-40',
          drop.isOver && 'bg-accent10 shadow-[inset_0_0_0_2px_var(--accent)]',
        )}
      >
        <Avatar name={n.user.name} src={n.user.imageUrl} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{n.user.name}</span>
          <span className="truncate text-xs text-fg2">
            {[n.title, n.department].filter(Boolean).join(' · ')}
          </span>
        </span>
        {n.managerSynced ? <Icon name="lock" size={12} className="text-fg3" /> : null}
        {n.reportCount ? <span className="text-xs text-fg3">{n.reportCount}</span> : null}
      </button>
    </ActionContextMenu>
  );
}
