import { BOARD_LIMITS, type BoardCard } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Segmented,
  Skeleton,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { SaveTemplateBody } from '@/components/templates/SaveTemplate';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { useBoardActions } from '@/lib/boards/actions';
import { boardQuery, useBoardLive } from '@/lib/boards/api';
import {
  BOARD_VIEWS,
  cardRef,
  hasFilters,
  sprintScope,
  toSearch,
  visibleCards,
  type BoardSearch,
  type BoardView,
} from '@/lib/boards/filters';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { ArchivedDialog } from './ArchivedDialog';
import { BacklogView } from './BacklogView';
import { BoardsSidebar } from './BoardsSidebar';
import { useCardMenu } from './cardMenu';
import { canManageBoard } from './permissions';
import { FilterBar } from './FilterBar';
import { Kanban } from './Kanban';
import { ListView } from './ListView';
import { SprintBand } from './sprints';
import { TimelineView } from './TimelineView';
import { TimerPill } from './CardTime';
import { WorkloadView } from './WorkloadView';

const VIEW_KEY = 'crewhall.boards.view';

const isView = (v: unknown): v is (typeof BOARD_VIEWS)[number] =>
  (BOARD_VIEWS as readonly unknown[]).includes(v);

function rememberedView(boardId: string): BoardView {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, string>;
    const v = all[boardId];
    return isView(v) ? v : 'board';
  } catch {
    return 'board';
  }
}

function rememberView(boardId: string, view: BoardView) {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, string>;
    all[boardId] = view;
    localStorage.setItem(VIEW_KEY, JSON.stringify(all));
  } catch {
    /* best effort */
  }
}

/** A dialog, not `window.prompt`: the desktop app (Electron) has no prompt at all. */
function AddCardBody({
  onAdd,
  onClose,
}: {
  onAdd: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd(title.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogContent>
      <DialogHeader title={t('boards.toolbar.addCard')} />
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
        <Input
          autoFocus
          value={title}
          maxLength={BOARD_LIMITS.titleLength}
          onChange={(e) => setTitle(e.target.value)}
          aria-label={t('boards.toolbar.addCard')}
          placeholder={t('boards.composer.placeholder')}
        />
        <DialogFooter>
          <Button type="button" variant="gh" onClick={onClose}>
            {t('boards.composer.cancel')}
          </Button>
          <Button type="submit" variant="inv" loading={busy} disabled={!title.trim()}>
            {t('boards.composer.add')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * A board (design 6.1-6.9): kanban or list, filters in the address, live refresh, the card
 * modal and settings as child routes.
 */
export function BoardPage({
  boardId,
  search,
  openCardId,
  children,
}: {
  boardId: string;
  search: BoardSearch;
  openCardId?: string | null;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const me = useMe();
  const meId = me?.user.id ?? '';
  const q = useQuery(boardQuery(boardId));
  const { items: spaces } = useSpaces();
  useBoardLive(boardId, openCardId);
  const actions = useBoardActions(boardId);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [adding, setAdding] = useState(false);
  const detail = q.data;
  const space = spaces.find((s) => s.id === detail?.board.spaceId);

  // A view chosen once per board is remembered; ?view= in a link wins.
  useEffect(() => {
    const remembered = rememberedView(boardId);
    if (search.view === undefined && remembered !== 'board') {
      void navigate({ to: '.', search: toSearch({ ...search, view: remembered }), replace: true });
    }
    // Only when the board opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  const view: BoardView = search.view ?? 'board';
  // While a sprint runs, the kanban and the list show its cards; the other views show all.
  const scoped = useMemo(
    () => (detail && (view === 'board' || view === 'list') ? sprintScope(detail) : detail),
    [detail, view],
  );
  const visible = useMemo(
    () => (scoped ? visibleCards(scoped, search, meId) : []),
    [scoped, search, meId],
  );

  const setSearch = (next: BoardSearch) =>
    void navigate({ to: '.', search: toSearch(next), replace: true });

  const open = (card: BoardCard) => {
    if (!detail) return;
    void navigate({
      to: '/b/$boardId/$cardRef',
      params: { boardId, cardRef: cardRef(detail.board.settings.key, card.number) },
      search: toSearch(search),
    });
  };
  const cardMenu = useCardMenu({ detail, actions, meId, onOpen: open });

  if (q.isLoading || !detail || !scoped) {
    return (
      <Workspace sidebar={<BoardsSidebar space={space} activeBoardId={boardId} />}>
        {q.isError ? (
          <EmptyState className="m-auto" icon="board" title={t('boards.errors.load')} />
        ) : (
          <div className="flex gap-3">
            <Skeleton className="h-80 w-72" />
            <Skeleton className="h-80 w-72" />
            <Skeleton className="h-80 w-72" />
          </div>
        )}
      </Workspace>
    );
  }

  const canEdit = detail.board.myRole !== 'viewer';
  const canManage = canManageBoard(detail);

  return (
    <Workspace
      sidebar={
        <BoardsSidebar
          space={space}
          activeBoardId={boardId}
          onArchived={() => setArchivedOpen(true)}
        />
      }
      crumbs={[
        { label: space ? spaceName(space, t) : detail.board.space.name },
        { label: detail.board.name },
      ]}
      bodyClassName="gap-3 px-6 py-4 overflow-hidden"
      tools={
        <>
          <TimerPill />
          <IconButton
            size="sm"
            aria-label={t('templates.saveTitle.board')}
            onClick={() => setSaveTemplate(true)}
          >
            <Icon name="layers" size={16} />
          </IconButton>
          {canManage ? (
            <IconButton
              size="sm"
              aria-label={t('boards.toolbar.settings')}
              onClick={() =>
                void navigate({
                  to: '/b/$boardId/settings',
                  params: { boardId },
                  search: toSearch(search),
                })
              }
            >
              <Icon name="settings" size={16} />
            </IconButton>
          ) : null}
          <Dialog open={saveTemplate} onOpenChange={setSaveTemplate}>
            {saveTemplate ? (
              <SaveTemplateBody
                kind="board"
                nodeId={boardId}
                spaceId={detail.board.spaceId}
                defaultName={detail.board.name}
                onClose={() => setSaveTemplate(false)}
              />
            ) : null}
          </Dialog>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-h font-bold text-fg">{detail.board.name}</h1>
        <span className="rounded-full bg-bg2 px-2 py-0.5 text-xs font-semibold text-fg2">
          {t('boards.board')}
        </span>
        <Segmented
          value={view}
          size="sm"
          aria-label={t('boards.views.board')}
          onValueChange={(v) => {
            rememberView(boardId, isView(v) ? v : 'board');
            setSearch({ ...search, view: isView(v) ? v : undefined });
          }}
          options={[
            { value: 'board', label: t('boards.views.board') },
            { value: 'list', label: t('boards.views.list') },
            { value: 'backlog', label: t('boards.views.backlog') },
            { value: 'timeline', label: t('boards.views.timeline') },
            { value: 'workload', label: t('boards.views.workload') },
          ]}
        />
        {view === 'list' ? (
          <Segmented
            value={search.group ?? 'column'}
            size="sm"
            aria-label={t('boards.views.groupBy', { by: '' })}
            onValueChange={(v) =>
              setSearch({ ...search, group: v === 'column' ? undefined : (v as 'person' | 'tag') })
            }
            options={[
              { value: 'column', label: t('boards.views.group.column') },
              { value: 'person', label: t('boards.views.group.person') },
              { value: 'tag', label: t('boards.views.group.label') },
            ]}
          />
        ) : null}
        <label className="ml-auto flex h-9 w-[240px] items-center gap-2 rounded-md bg-bg2 px-2.5">
          <Icon name="search" size={15} className="text-fg3" />
          <input
            value={search.q ?? ''}
            onChange={(e) => setSearch({ ...search, q: e.target.value || undefined })}
            placeholder={t('boards.toolbar.search')}
            aria-label={t('boards.toolbar.search')}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg3"
          />
        </label>
        {canEdit && detail.columns[0] ? (
          <Button size="sm" variant="inv" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            {t('boards.toolbar.addCard')}
          </Button>
        ) : null}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding ? (
          <AddCardBody
            onClose={() => setAdding(false)}
            onAdd={async (title) => {
              const card = await actions.addCard({
                columnId: detail.columns[0]!.id,
                title,
                top: true,
              });
              setAdding(false);
              if (card) open(card);
            }}
          />
        ) : null}
      </Dialog>
      {view === 'board' || view === 'list' ? (
        <SprintBand detail={detail} canManage={canManage} actions={actions} />
      ) : null}
      <FilterBar
        detail={scoped}
        search={search}
        meId={meId}
        shown={visible.length}
        onChange={setSearch}
      />
      {detail.cards.length === 0 && canEdit ? (
        <p className="rounded-lg bg-accent10 px-3 py-2 text-[13px] text-fg">
          {t('boards.composer.hintFirst')}
        </p>
      ) : null}
      {view === 'workload' ? (
        <WorkloadView source={{ boardId }} />
      ) : view === 'timeline' ? (
        <TimelineView
          detail={detail}
          visible={visible}
          canEdit={canEdit}
          actions={actions}
          onOpen={open}
        />
      ) : view === 'backlog' ? (
        <BacklogView
          detail={detail}
          visible={visible}
          canEdit={canEdit}
          canManage={canManage}
          actions={actions}
          onOpen={open}
        />
      ) : view === 'board' ? (
        <Kanban
          detail={scoped}
          visible={visible}
          filtered={hasFilters(search)}
          canEdit={canEdit}
          canManage={canManage}
          onOpen={open}
          onMove={(m) => void actions.move(m)}
          onMoveColumn={(m) => void actions.moveColumn(m.columnId, m.afterId, m.beforeId)}
          onAddColumn={(name) => void actions.addColumn(name)}
          onAdd={async (c) => {
            const card = await actions.addCard({
              columnId: c.columnId,
              title: c.title,
              labels: c.labels,
              assigneeIds: c.assigneeIds,
            });
            if (card && c.open) open(card);
          }}
          cardMenu={cardMenu}
        />
      ) : (
        <ListView
          detail={scoped}
          visible={visible}
          groupBy={
            search.group === 'person' ? 'person' : search.group === 'tag' ? 'label' : 'column'
          }
          meId={meId}
          canEdit={canEdit}
          actions={actions}
          onOpen={open}
          cardMenu={cardMenu}
        />
      )}
      <ArchivedDialog
        detail={detail}
        open={archivedOpen}
        canEdit={canEdit}
        onClose={() => setArchivedOpen(false)}
      />
      {children}
    </Workspace>
  );
}
