import { exportToSvg, loadLibraryFromBlob } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { type Drawing, type LibraryItem } from '@crewhall/shared';
import { Button, cn, Icon, IconButton, toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useState } from 'react';
import { api as http } from '@/lib/api';
import { boardKeys, libraryQuery } from '@/lib/boards/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { BUILTIN_SETS, builtinItem, insertItem, selectionItem } from './library';

type Tab = 'space' | 'personal' | 'builtin';

/**
 * Shape library (design 6.12), opened from the right: the space library shared by its
 * members, the personal one and the built-in sets. Items drop into the middle of the view
 * as a group; the selection can be saved; .excalidrawlib files can be imported.
 */
export function LibraryPanel({
  drawing,
  excalidraw,
  onClose,
}: {
  drawing: Drawing;
  excalidraw: ExcalidrawImperativeAPI | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const lib = useQuery(libraryQuery(drawing.spaceId));
  const [tab, setTab] = useState<Tab>('space');
  const [q, setQ] = useState('');
  const builtin = useMemo(
    () =>
      BUILTIN_SETS.map((s) => ({
        set: s.set,
        items: s.items.map((k) => builtinItem(k, t(`boards.library.items.${k}`))),
      })),
    [t],
  );

  const save = async (scope: 'space' | 'personal', items: LibraryItem[]) => {
    try {
      const next = await http.call('updateDrawingLibrary', {
        body: { scope, spaceId: scope === 'space' ? drawing.spaceId : undefined, items },
      });
      qc.setQueryData(boardKeys.library(drawing.spaceId), next);
      if (scope === 'personal') {
        void excalidraw?.updateLibrary({ libraryItems: next.personal as never, merge: false });
      }
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  const items =
    tab === 'space'
      ? (lib.data?.space ?? [])
      : tab === 'personal'
        ? (lib.data?.personal ?? [])
        : [];
  const filter = (list: LibraryItem[]) =>
    q.trim()
      ? list.filter((i) =>
          (i.name ?? '').toLocaleLowerCase('tr').includes(q.toLocaleLowerCase('tr')),
        )
      : list;
  const canWrite = tab === 'personal' || (tab === 'space' && lib.data?.canEditSpace);

  const addSelection = () => {
    if (!excalidraw) return;
    const item = selectionItem(excalidraw);
    if (!item) return toast(t('boards.library.noSelection'));
    void save(tab === 'space' ? 'space' : 'personal', [item, ...items]);
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const imported = (await loadLibraryFromBlob(file)) as unknown as LibraryItem[];
      await save(tab === 'space' ? 'space' : 'personal', [...imported, ...items]);
      toast(t('boards.library.imported', { count: imported.length }));
    } catch {
      toast(t('boards.library.invalid'));
    }
  };

  return (
    <aside
      aria-label={t('boards.library.title')}
      className="absolute top-16 right-3 bottom-3 z-20 flex w-[300px] flex-col gap-3 rounded-2xl border border-glass-line bg-surface p-3 shadow-overlay"
    >
      <header className="flex items-center gap-2">
        <h3 className="text-sub font-semibold">{t('boards.library.title')}</h3>
        <IconButton
          size="xs"
          tone="plain"
          className="ml-auto"
          aria-label={t('boards.detail.close')}
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </IconButton>
      </header>
      <label className="flex h-9 items-center gap-2 rounded-md bg-bg2 px-2.5">
        <Icon name="search" size={15} className="text-fg3" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('boards.library.search')}
          aria-label={t('boards.library.search')}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg3"
        />
      </label>
      <div role="tablist" className="flex gap-1">
        {(
          [
            ['space', drawing.space.name],
            ['personal', t('boards.library.personal')],
            ['builtin', t('boards.library.builtin')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'h-7 flex-1 truncate rounded-full px-2 text-xs font-semibold',
              tab === id ? 'bg-fg text-bg' : 'bg-bg2 text-fg2 hover:bg-capsule',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {tab === 'builtin' ? (
          builtin.map((s) => (
            <section key={s.set} className="flex flex-col gap-2">
              <span className="eyebrow">{t(`boards.library.sets.${s.set}`)}</span>
              <Grid
                items={filter(s.items)}
                onInsert={(i) => excalidraw && insertItem(excalidraw, i)}
              />
            </section>
          ))
        ) : filter(items).length ? (
          <Grid
            items={filter(items)}
            onInsert={(i) => excalidraw && insertItem(excalidraw, i)}
            onRemove={
              canWrite
                ? (i) =>
                    void save(
                      tab === 'space' ? 'space' : 'personal',
                      items.filter((x) => x.id !== i.id),
                    )
                : undefined
            }
          />
        ) : (
          <p className="py-6 text-center text-xs text-fg3">{t('boards.library.empty')}</p>
        )}
      </div>
      {tab !== 'builtin' && canWrite ? (
        <footer className="flex flex-col gap-2 border-t border-line pt-3">
          <Button size="xs" variant="out" onClick={addSelection}>
            <Icon name="plus" size={14} />
            {tab === 'space'
              ? t('boards.library.addSelectionSpace')
              : t('boards.library.addSelection')}
          </Button>
          <label className="flex cursor-pointer items-center justify-center rounded-md border border-dashed border-line2 px-2 py-2 text-center text-[11.5px] text-fg3 hover:bg-bg2">
            {t('boards.library.importHint')}
            <input
              type="file"
              accept=".excalidrawlib,application/json"
              className="sr-only"
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
          </label>
        </footer>
      ) : null}
    </aside>
  );
}

function Grid({
  items,
  onInsert,
  onRemove,
}: {
  items: LibraryItem[];
  onInsert: (i: LibraryItem) => void;
  onRemove?: (i: LibraryItem) => void;
}) {
  const { t } = useI18n();
  return (
    <ul className="grid grid-cols-3 gap-2">
      {items.map((i) => (
        <li key={i.id} className="group relative">
          <button
            type="button"
            title={i.name ?? t('boards.library.insert')}
            aria-label={`${t('boards.library.insert')}: ${i.name ?? ''}`}
            onClick={() => onInsert(i)}
            className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg bg-bg2 p-1.5 hover:shadow-[0_0_0_1px_var(--line2)]"
          >
            <Thumb item={i} />
            {i.name ? (
              <span className="w-full truncate text-center text-[10.5px] text-fg2">{i.name}</span>
            ) : null}
          </button>
          {onRemove ? (
            <button
              type="button"
              aria-label={t('boards.library.remove')}
              onClick={() => onRemove(i)}
              className="absolute top-1 right-1 hidden size-5 items-center justify-center rounded-full bg-surface text-fg3 shadow-sm group-hover:flex hover:text-danger"
            >
              <Icon name="x" size={11} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Rendered previews by item id and content, so re-renders never export again. */
const thumbs = new Map<string, string>();

const Thumb = memo(function Thumb({ item }: { item: LibraryItem }) {
  const cacheKey = `${item.id}:${item.elements.length}:${item.elements.reduce((s, e) => s + e.version, 0)}`;
  const [svg, setSvg] = useState<string | null>(() => thumbs.get(cacheKey) ?? null);
  useEffect(() => {
    if (thumbs.has(cacheKey)) return;
    let alive = true;
    void exportToSvg({
      elements: item.elements as unknown as ExcalidrawElement[],
      appState: { exportBackground: false, viewBackgroundColor: 'transparent' },
      files: null,
      exportPadding: 4,
      skipInliningFonts: true,
    })
      .then((el: SVGSVGElement) => {
        el.removeAttribute('width');
        el.removeAttribute('height');
        // As an image: imported library SVG never runs or links anything.
        const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(el.outerHTML)}`;
        thumbs.set(cacheKey, url);
        if (alive) setSvg(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // The cache key covers the item's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);
  return svg ? (
    <img src={svg} alt="" className="max-h-[64px] max-w-full object-contain" />
  ) : (
    <span className="size-8 rounded bg-line" />
  );
});
