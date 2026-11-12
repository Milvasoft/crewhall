import { queryKeys } from '@crewhall/api-client';
import { type Card, type CardType, type Surface, type SurfaceSummary } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  Icon,
  Skeleton,
  SpaceBadge,
  SpaceDot,
  toast,
  type IconName,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { NodePickerDialog } from '@/features/drive/NodePickerDialog';
import { api, isApiError } from '@/lib/api';
import { openDialog, useDialog } from '@/lib/dialogs';
import { errorKey } from '@/lib/errors';
import { formatRelative, formatWeekdayDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useCardTypeEnabled } from '@/lib/identity/modules';
import { useMe } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { AddLinkDialog, normalizeUrl } from './AddLinkDialog';
import {
  dropCard,
  putCard,
  refreshOtherSurfaces,
  setLayouts,
  surfaceQuery,
  surfacesQuery,
  type Layout,
} from './api';
import { QuickContext, type QuickContextValue } from './context';
import { Gallery } from './Gallery';
import { ModulePicker, type PickerKind } from './ModulePickers';
import { canEditCard, EditCardDialog } from './EditCardDialog';
import { MoveCardDialog } from './MoveCardDialog';
import { GroupSettings } from './GroupSettings';
import { SurfaceGrid } from './SurfaceGrid';
import { AnnouncementsCard } from '@/components/announcements/AnnouncementsCard';
import { PluginCards } from '@/components/plugins/PluginCards';
import { CelebrationsCard } from '@/components/announcements/Kudos';

const UNDO_DEPTH = 20;

/** Layout writes per surface run one after another: each needs the previous layoutRev. */
const layoutChains = new Map<string, Promise<unknown>>();
/** Config writes per card: queued, and a counter so stale answers are ignored. */
const configChains = new Map<string, Promise<unknown>>();
const configSeq = new Map<string, number>();

function greetingKey(h: number) {
  if (h < 5) return 'home.greeting.night' as const;
  if (h < 12) return 'home.greeting.morning' as const;
  if (h < 18) return 'home.greeting.afternoon' as const;
  return 'home.greeting.evening' as const;
}

/**
 * Home: quick access surfaces (design 02). "Benim" is personal; every shared space the
 * person belongs to has a surface too (`?surface=<space slug>`). When the server does not
 * serve surfaces yet (501), `fallback` (the phase 0 welcome) is shown instead.
 */
export function QuickHome({
  surfaceSlug,
  onSurfaceSlug,
  fallback,
}: {
  surfaceSlug: string | undefined;
  onSurfaceSlug: (slug: string | undefined) => void;
  fallback: ReactNode;
}) {
  const { t } = useI18n();
  const surfaces = useQuery(surfacesQuery);
  const { items: spaces } = useSpaces();
  const list = surfaces.data?.items ?? [];
  // Space surfaces are addressed by the space slug; the summary only carries the id.
  const slugOf = ({ owner }: SurfaceSummary) =>
    owner.type === 'space' ? (spaces.find((x) => x.id === owner.spaceId)?.slug ?? '') : '';
  const mine = list.find((s) => s.owner.type === 'user');
  const selected =
    (surfaceSlug && list.find((s) => s.owner.type === 'space' && slugOf(s) === surfaceSlug)) ||
    mine;

  if (surfaces.error && isApiError(surfaces.error, 'not_implemented')) return <>{fallback}</>;

  const tabs = (
    <div
      role="tablist"
      aria-label={t('home.surfaces')}
      className="flex items-center gap-1 rounded-md bg-bg2 p-[3px]"
    >
      {list.slice(0, 6).map((s) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={s.id === selected?.id}
          onClick={() => onSurfaceSlug(s.owner.type === 'space' ? slugOf(s) : undefined)}
          className={cn(
            'flex h-[30px] items-center gap-1.5 rounded-sm px-3 text-cap font-medium whitespace-nowrap text-fg2 hover:text-fg',
            s.id === selected?.id && 'bg-surface font-semibold text-fg shadow-sm dark:bg-capsule',
          )}
        >
          {s.owner.type === 'space' ? (
            <SpaceDot color={s.owner.spaceColor} />
          ) : (
            <SpaceDot color="s6" />
          )}
          {s.owner.type === 'space' ? s.owner.spaceName : t('home.mine')}
        </button>
      ))}
    </div>
  );

  if (!selected) {
    return (
      <Workspace topLeft={tabs}>
        {surfaces.isError ? (
          <LoadError onRetry={() => void surfaces.refetch()} />
        ) : (
          <GridSkeleton />
        )}
      </Workspace>
    );
  }
  return (
    <SurfacePage
      key={selected.id}
      summary={selected}
      surfaces={list}
      mineId={mine?.id ?? null}
      tabs={tabs}
    />
  );
}

function SurfacePage({
  summary,
  surfaces,
  mineId,
  tabs,
}: {
  summary: SurfaceSummary;
  surfaces: SurfaceSummary[];
  mineId: string | null;
  tabs: ReactNode;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  const [editing, setEditing] = useState(false);
  // A module turned off hides its cards (boards, pages, chat, meetings, vault); none is removed.
  const typeOn = useCardTypeEnabled();
  // No background refresh while cards are being dragged.
  const q = useQuery({ ...surfaceQuery(summary.id), refetchInterval: editing ? false : 60_000 });
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  // The card gallery opens with "Kart ekle" only; "Düzenle" is for arranging what is there.
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [linkDialog, setLinkDialog] = useState<{
    url?: string;
    groupCardId?: string;
    sectionId?: string;
  } | null>(null);
  const [nodePicker, setNodePicker] = useState<Layout | null | undefined>(undefined);
  const [modulePicker, setModulePicker] = useState<{
    kind: PickerKind;
    layout: Layout | null;
  } | null>(null);
  const [history, setHistory] = useState<Record<string, Layout>[]>([]);
  const surface = q.data;
  const canEdit = summary.canEdit;
  const surfaceName = summary.owner.type === 'space' ? summary.owner.spaceName : t('home.mine');
  const now = new Date();
  const firstName = me?.user.name.split(' ')[0] ?? '';

  const current = (): Surface | undefined => qc.getQueryData(queryKeys.surface(summary.id));

  const fail = (e: unknown) => {
    toast(t(errorKey(e)));
    void qc.invalidateQueries({ queryKey: queryKeys.surface(summary.id) });
  };

  /** Saves positions one write at a time so each carries the latest layoutRev. */
  const saveLayout = (next: Record<string, Layout>, record = true) => {
    const sf = current();
    if (!sf) return;
    const changed = sf.cards.filter((c) => {
      const n = next[c.id];
      return (
        n && (n.x !== c.layout.x || n.y !== c.layout.y || n.w !== c.layout.w || n.h !== c.layout.h)
      );
    });
    if (!changed.length) return;
    if (record) {
      const before = Object.fromEntries(sf.cards.map((c) => [c.id, c.layout]));
      setHistory((h) => [...h.slice(-(UNDO_DEPTH - 1)), before]);
    }
    setLayouts(qc, sf.id, next);
    const prevWrite = layoutChains.get(sf.id) ?? Promise.resolve();
    const write = prevWrite.then(async () => {
      const rev = current()?.layoutRev ?? sf.layoutRev;
      try {
        const res = await api.call('updateSurfaceLayout', {
          params: { surfaceId: sf.id },
          body: {
            layoutRev: rev,
            items: changed.map((c) => ({ cardId: c.id, layout: next[c.id]! })),
          },
        });
        setLayouts(qc, sf.id, {}, res.layoutRev);
      } catch (e) {
        if (isApiError(e, 'conflict')) toast(t('quick.conflict'));
        else toast(t(errorKey(e)));
        await qc.invalidateQueries({ queryKey: queryKeys.surface(sf.id) });
      }
    });
    layoutChains.set(sf.id, write);
  };

  const undo = () => {
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    saveLayout(prev, false);
  };

  const create = async (body: Parameters<typeof api.call<'createCard'>>[1]['body']) => {
    try {
      const card = await api.call('createCard', { params: { surfaceId: summary.id }, body });
      putCard(qc, card);
      return card;
    } catch (e) {
      fail(e);
      return null;
    }
  };

  const createOfType = async (type: CardType, layout?: Layout) => {
    if (type === 'link') return setLinkDialog({});
    if (type === 'node') return setNodePicker(layout ?? null);
    if (type === 'link_group') {
      const card = await create({ type, config: { title: t('quick.gallery.newGroup') }, layout });
      if (card) setSettingsId(card.id);
      return;
    }
    if (type === 'todo') {
      await create({ type, config: { title: t('quick.todo.defaultTitle') }, layout });
      return;
    }
    if (type === 'board_assigned') {
      await create({ type, config: {}, layout });
      return;
    }
    if (type === 'page' || type === 'chat' || type === 'vault_item') {
      return setModulePicker({ kind: type, layout: layout ?? null });
    }
    if (type === 'meeting') {
      const spaceId = summary.owner.type === 'space' ? summary.owner.spaceId : null;
      await create({ type, config: { spaceId }, layout });
      return;
    }
    await create({ type: 'note', config: { text: '', color: 's5', fontSize: 'normal' }, layout });
  };

  const ctx: QuickContextValue | null = surface
    ? {
        surface,
        surfaces,
        editing,
        canEdit,
        mySurfaceId: mineId,
        updateConfig: (card, next) => {
          const latest = current()?.cards.find((c) => c.id === card.id) ?? card;
          const config = (
            typeof next === 'function' ? (next as (prev: unknown) => unknown)(latest.config) : next
          ) as Card['config'];
          putCard(qc, { ...latest, config } as Card);
          // One write at a time per card, and only the newest answer replaces the local state.
          const seq = (configSeq.get(card.id) ?? 0) + 1;
          configSeq.set(card.id, seq);
          const write = (configChains.get(card.id) ?? Promise.resolve()).then(() =>
            api
              .call('updateCard', { params: { cardId: card.id }, body: { config } })
              .then((saved) => {
                if (configSeq.get(card.id) !== seq) return;
                putCard(qc, saved);
                refreshOtherSurfaces(qc, summary.id);
              })
              .catch(fail),
          );
          configChains.set(card.id, write);
        },
        remove: (card) => {
          dropCard(qc, summary.id, card.id);
          if (settingsId === card.id) setSettingsId(null);
          api
            .call('deleteCard', { params: { cardId: card.id } })
            .then(() =>
              toast(t('quick.removed'), {
                duration: 8000,
                action: {
                  label: t('quick.undo'),
                  onClick: () =>
                    void api
                      .call('restoreCard', { params: { cardId: card.id } })
                      .then((c) => putCard(qc, c))
                      .catch(fail),
                },
              }),
            )
            .catch(fail);
        },
        duplicate: (card) =>
          void api
            .call('duplicateCard', { params: { cardId: card.id } })
            .then((c) => putCard(qc, c))
            .catch(fail),
        openMove: (card) => setMovingId(card.id),
        pin: (card, surfaceId) =>
          void api
            .call('pinCard', { params: { cardId: card.id }, body: { surfaceId } })
            .then((pinned) => {
              void qc.invalidateQueries({ queryKey: queryKeys.surface(surfaceId) });
              void qc.invalidateQueries({ queryKey: queryKeys.surfaces, exact: true });
              toast(t('quick.pin.done'), {
                duration: 8000,
                action: {
                  label: t('quick.undo'),
                  onClick: () =>
                    void api
                      .call('deleteCard', { params: { cardId: pinned.id } })
                      .then(() => qc.invalidateQueries({ queryKey: queryKeys.surface(surfaceId) })),
                },
              });
            })
            .catch(fail),
        resize: (card, [w, h]) => {
          const sf = current();
          if (!sf) return;
          const next = Object.fromEntries(sf.cards.map((c) => [c.id, c.layout]));
          next[card.id] = { ...card.layout, w, h, x: Math.min(card.layout.x, 12 - w) };
          saveLayout(next);
        },
        detach: (card) =>
          void api
            .call('updateCard', { params: { cardId: card.id }, body: { detach: true } })
            .then((c) => putCard(qc, c))
            .catch(fail),
        openSettings: (card) => {
          setEditing(true);
          setSettingsId(card.id);
        },
        openEdit: (card) => {
          if (!canEditCard(card)) return;
          if (card.type === 'link_group') {
            setEditing(true);
            setSettingsId(card.id);
          } else {
            setEditId(card.id);
          }
        },
        addLink: (opts) => setLinkDialog(opts ?? {}),
      }
    : null;

  const moveCard = (card: Card, surfaceId: string) => {
    const from = summary.id;
    void api
      .call('moveCard', { params: { cardId: card.id }, body: { surfaceId } })
      .then(() => {
        dropCard(qc, from, card.id);
        void qc.invalidateQueries({ queryKey: queryKeys.surface(surfaceId) });
        const target = surfaces.find((s) => s.id === surfaceId);
        toast(
          t('quick.moved', {
            name: target?.owner.type === 'space' ? target.owner.spaceName : t('home.mine'),
          }),
          {
            duration: 8000,
            // A vault card that came home does not go back to a shared surface.
            ...(card.type === 'vault_item'
              ? {}
              : {
                  action: {
                    label: t('quick.undo'),
                    onClick: () =>
                      void api
                        .call('moveCard', {
                          params: { cardId: card.id },
                          body: { surfaceId: from, layout: card.layout },
                        })
                        .then((c) => {
                          dropCard(qc, surfaceId, card.id);
                          putCard(qc, c);
                        })
                        .catch(fail),
                  },
                }),
          },
        );
      })
      .catch(fail);
  };
  const moving = surface?.cards.find((c) => c.id === movingId);

  // "Mevcut yüzeye link ekle" from the command palette (2.9) opens the same dialog.
  const appDialog = useDialog();
  const link = linkDialog ?? (appDialog === 'addLink' && canEdit ? {} : null);

  // Ctrl V with a URL anywhere on the surface opens "Link ekle" (2.4).
  useEffect(() => {
    if (!canEdit) return;
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      const url = normalizeUrl(e.clipboardData?.getData('text') ?? '');
      if (url) {
        e.preventDefault();
        setLinkDialog({ url });
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canEdit]);

  const settingsCard = surface?.cards.find(
    (c): c is Extract<Card, { type: 'link_group' }> =>
      c.id === settingsId && c.type === 'link_group',
  );

  const tools = canEdit ? (
    editing ? (
      <>
        <Button size="sm" variant="gh" disabled={!history.length} onClick={undo}>
          <Icon name="undo" size={16} />
          {t('quick.edit.undo')}
        </Button>
        <Button
          size="sm"
          variant={galleryOpen && !settingsCard ? 'out' : 'gh'}
          aria-pressed={galleryOpen && !settingsCard}
          onClick={() => {
            setSettingsId(null);
            setGalleryOpen((v) => !v || Boolean(settingsCard));
          }}
        >
          <Icon name="plus" size={16} />
          {t('quick.gallery.title')}
        </Button>
        <Button
          size="sm"
          variant="inv"
          onClick={() => {
            setEditing(false);
            setSettingsId(null);
            setGalleryOpen(false);
            setHistory([]);
          }}
        >
          {t('quick.edit.done')}
        </Button>
      </>
    ) : (
      <>
        <Button
          size="sm"
          variant="gh"
          onClick={() => {
            setGalleryOpen(false);
            setEditing(true);
          }}
        >
          <Icon name="edit" size={16} />
          {t('quick.edit.start')}
        </Button>
        <Button
          size="sm"
          variant="pri"
          onClick={() => {
            setEditing(true);
            setGalleryOpen(true);
          }}
        >
          <Icon name="plus" size={16} />
          {t('quick.gallery.title')}
        </Button>
      </>
    )
  ) : null;

  const panel =
    editing && ctx ? (
      settingsCard ? (
        <GroupSettings card={settingsCard} onClose={() => setSettingsId(null)} />
      ) : galleryOpen ? (
        <Gallery
          surfaceName={surfaceName}
          onPick={(type) => void createOfType(type)}
          onClose={() => setGalleryOpen(false)}
        />
      ) : null
    ) : null;

  const empty = surface && surface.cards.length === 0;

  return (
    <Workspace
      topLeft={
        editing ? (
          <span className="text-cap font-semibold">
            {surfaceName} <span className="font-normal text-fg2">· {t('quick.edit.editing')}</span>
          </span>
        ) : (
          tabs
        )
      }
      tools={tools}
      panel={ctx ? <QuickContext.Provider value={ctx}>{panel}</QuickContext.Provider> : null}
    >
      {summary.owner.type === 'user' ? (
        <div className="flex shrink-0 items-end justify-between gap-4">
          <h1 className="m-0 text-wtitle font-bold">
            {t(greetingKey(now.getHours()), { name: firstName })}
          </h1>
          <span className="text-[13.5px] leading-[18px] text-fg2">
            {formatWeekdayDate(now, locale)}
          </span>
        </div>
      ) : surface ? (
        <SpaceStrip summary={summary} surface={surface} />
      ) : null}
      {summary.owner.type === 'user' && !editing ? <AnnouncementsCard /> : null}
      {summary.owner.type === 'user' && !editing ? <CelebrationsCard /> : null}

      {q.isLoading ? (
        <GridSkeleton />
      ) : q.isError || !surface || !ctx ? (
        <LoadError onRetry={() => void q.refetch()} />
      ) : empty && summary.owner.type === 'user' && !editing ? (
        <QuickContext.Provider value={ctx}>
          <FirstRun
            name={firstName}
            surfaces={surfaces}
            onStart={(type) => (type ? void createOfType(type) : setEditing(true))}
          />
        </QuickContext.Provider>
      ) : empty && !editing ? (
        <EmptyState
          icon="grid"
          title={t('quick.empty.title')}
          description={canEdit ? t('quick.empty.body') : t('quick.empty.viewer')}
        >
          {canEdit ? (
            <Button variant="inv" onClick={() => setEditing(true)}>
              {t('quick.gallery.title')}
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <QuickContext.Provider value={ctx}>
          <SurfaceGrid
            cards={surface.cards.filter((c) => typeOn(c.type))}
            editable={editing && canEdit}
            onLayout={(next) => saveLayout(next)}
            onDropNew={(type, layout) => void createOfType(type, layout)}
            onBackgroundDoubleClick={canEdit ? () => void createOfType('note') : undefined}
          />
        </QuickContext.Provider>
      )}

      {summary.owner.type === 'user' && !editing ? <PluginCards /> : null}

      {ctx ? (
        <QuickContext.Provider value={ctx}>
          <EditCardDialog
            card={surface?.cards.find((c) => c.id === editId) ?? null}
            onClose={() => setEditId(null)}
          />
        </QuickContext.Provider>
      ) : null}
      {moving ? (
        <MoveCardDialog
          card={moving}
          onClose={() => setMovingId(null)}
          onMove={(surfaceId) => {
            setMovingId(null);
            moveCard(moving, surfaceId);
          }}
        />
      ) : null}
      {surface ? (
        <AddLinkDialog
          open={link !== null}
          onClose={() => {
            setLinkDialog(null);
            if (appDialog === 'addLink') openDialog(null);
          }}
          surface={surface}
          surfaceName={surfaceName}
          initialUrl={link?.url}
          initialGroupId={link?.groupCardId}
          initialSectionId={link?.sectionId}
        />
      ) : null}
      <ModulePicker
        kind={modulePicker?.kind ?? null}
        onClose={() => setModulePicker(null)}
        onPick={(pick) => {
          const layout = modulePicker?.layout ?? undefined;
          setModulePicker(null);
          void create({ ...pick, layout });
        }}
      />
      <NodePickerDialog
        open={nodePicker !== undefined}
        title={t('quick.nodePicker.title')}
        confirm={t('quick.nodePicker.add')}
        onClose={() => setNodePicker(undefined)}
        onPick={(node) => {
          const layout = nodePicker ?? undefined;
          setNodePicker(undefined);
          void create({
            type: 'node',
            config: { nodeId: node.id, ...(node.type === 'folder' ? { maxItems: 3 } : {}) },
            layout: layout && node.type === 'file' ? { ...layout, w: 2, h: 1 } : layout,
          });
        }}
      />
    </Workspace>
  );
}

function SpaceStrip({ summary, surface }: { summary: SurfaceSummary; surface: Surface }) {
  const { t, locale } = useI18n();
  if (summary.owner.type !== 'space') return null;
  return (
    <section className="flex shrink-0 items-center gap-3.5 rounded-2xl bg-surface px-4 py-3 shadow-line">
      <SpaceBadge color={summary.owner.spaceColor} name={summary.owner.spaceName} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold">
          {t('home.spaceSurfaceTitle', { name: summary.owner.spaceName })}
        </span>
        <span className="truncate text-xs text-fg2">
          {summary.canEdit ? t('quick.strip.editors') : t('quick.strip.viewer')}
        </span>
      </div>
      {surface.updatedBy ? (
        <span className="flex shrink-0 items-center gap-2 text-xs text-fg2">
          <Avatar name={surface.updatedBy.name} size="sm" />
          {t('quick.strip.lastChange', {
            name: surface.updatedBy.name.split(' ')[0] ?? '',
            when: formatRelative(surface.updatedAt, locale),
          })}
        </span>
      ) : null}
    </section>
  );
}

/** 2.11 without templates (out of scope in phase 1): start empty or pin from a space surface. */
function FirstRun({
  name,
  surfaces,
  onStart,
}: {
  name: string;
  surfaces: SurfaceSummary[];
  onStart: (type: CardType | null) => void;
}) {
  const { t } = useI18n();
  const spaceSurface = surfaces.find((s) => s.owner.type === 'space' && s.cardCount > 0);
  const source = useQuery({
    ...surfaceQuery(spaceSurface?.id ?? ''),
    enabled: Boolean(spaceSurface),
  });
  const qc = useQueryClient();
  const mine = surfaces.find((s) => s.owner.type === 'user');
  const options: {
    type: CardType | null;
    icon: 'link' | 'sticky' | 'grid';
    key: 'link' | 'note' | 'gallery';
  }[] = [
    { type: 'link', icon: 'link', key: 'link' },
    { type: 'note', icon: 'sticky', key: 'note' },
    { type: null, icon: 'grid', key: 'gallery' },
  ];
  return (
    <section className="flex flex-col items-center gap-2 rounded-2xl bg-surface px-6 py-10 text-center shadow-line">
      <span className="eyebrow">{t('home.eyebrow')}</span>
      <h2 className="m-0 text-title font-bold">{t('home.emptyTitle', { name })}</h2>
      <p className="m-0 max-w-[560px] text-sm text-fg2">{t('quick.firstRun.body')}</p>
      <div className="mt-4 grid w-full max-w-[760px] grid-cols-3 gap-3 text-left">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onStart(o.type)}
            className="flex flex-col gap-1.5 rounded-xl p-4 text-left shadow-line transition-colors hover:bg-bg2 hover:shadow-line2"
          >
            <span className="flex size-9 items-center justify-center rounded-md bg-bg2 text-fg">
              <Icon name={o.icon} size={18} />
            </span>
            <span className="text-sm font-semibold">{t(`quick.firstRun.${o.key}`)}</span>
            <span className="text-cap text-fg2">{t(`quick.firstRun.${o.key}Hint`)}</span>
          </button>
        ))}
      </div>
      {spaceSurface && spaceSurface.owner.type === 'space' && source.data && mine ? (
        <div className="mt-6 flex w-full max-w-[760px] flex-col gap-2 text-left">
          <span className="eyebrow">
            {t('quick.firstRun.pinFrom', { name: spaceSurface.owner.spaceName })}
          </span>
          <div className="grid grid-cols-2 gap-2">
            {source.data.cards.slice(0, 4).map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 shadow-line"
              >
                <span className="flex size-8 items-center justify-center rounded-md bg-bg2">
                  <Icon name={CARD_ICON[c.type]} size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate text-cap font-semibold">
                  {cardTitle(c, t)}
                </span>
                <Button
                  size="xs"
                  onClick={() =>
                    void api
                      .call('pinCard', { params: { cardId: c.id }, body: { surfaceId: mine.id } })
                      .then(() => {
                        void qc.invalidateQueries({ queryKey: queryKeys.surface(mine.id) });
                        void qc.invalidateQueries({ queryKey: queryKeys.surfaces, exact: true });
                      })
                  }
                >
                  {t('quick.firstRun.pin')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function cardTitle(c: Card, t: ReturnType<typeof useI18n>['t']): string {
  switch (c.type) {
    case 'link':
      return c.config.item.title;
    case 'link_group':
      return c.config.title;
    case 'todo':
      return c.config.title;
    case 'note':
      return c.config.text.split('\n')[0]?.replace(/^#+\s*/, '') || t('quick.note.title');
    case 'node':
      return c.node?.name ?? t('quick.node.locked');
    case 'board_assigned':
      return c.config.scope === 'due' ? t('boards.assigned.dueTitle') : t('boards.assigned.card');
    case 'page':
      return c.node?.name ?? t('quick.node.locked');
    case 'chat':
      return t('quick.gallery.kinds.chat');
    case 'meeting':
      return t('quick.meeting.title');
    case 'vault_item':
      return t('quick.vault.title');
  }
}

const CARD_ICON: Record<Card['type'], IconName> = {
  link: 'link',
  link_group: 'list',
  note: 'sticky',
  todo: 'todo',
  node: 'folder',
  board_assigned: 'board',
  page: 'page',
  chat: 'chat',
  meeting: 'video',
  vault_item: 'vault',
};

function GridSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-3.5" aria-busy="true">
      {[
        [3, 5],
        [3, 2],
        [2, 1],
        [2, 1],
        [2, 1],
        [3, 3],
        [3, 2],
      ].map(([w, h], i) => (
        <div key={i} style={{ gridColumn: `span ${w}`, height: h! * 84 + (h! - 1) * 14 }}>
          <Skeleton className="h-full rounded-2xl" />
        </div>
      ))}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <EmptyState icon="alert" title={t('quick.error.title')} description={t('quick.error.body')}>
      <Button variant="inv" onClick={onRetry}>
        {t('common.actions.retry')}
      </Button>
    </EmptyState>
  );
}

export function useHomeNavigate() {
  const navigate = useNavigate();
  return (slug: string | undefined) =>
    void navigate({ to: '/', search: slug ? { surface: slug } : {} });
}
