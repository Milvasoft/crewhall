import { pagePath, type PageTreeItem, type OrgMember } from '@crewhall/shared';
import { cn, Icon, SuggestionPanel, type IconName } from '@crewhall/ui';
import type { Editor, Range } from '@tiptap/core';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { formatDate } from '@/lib/i18n/format';
import { useI18n, type WebKey } from '@/lib/i18n/I18nContext';
import { fold, suggestStore, type SuggestItem } from '@/lib/wiki/editor/suggest';

/** What the editor's menus need from the page around it. */
export interface EditorHost {
  createSubpage: () => Promise<{ id: string; name: string } | null>;
  pages: PageTreeItem[];
  people: OrgMember[];
  /** User ids that can open the page (others get "Erişimi yok"). */
  spaceMemberIds: Set<string>;
}

interface Entry {
  id: string;
  icon: IconName;
  label: string;
  hint?: string;
  group: string;
  run: (editor: Editor, range: Range) => void;
}

export function insertPageLink(
  editor: Editor,
  range: Range | null,
  page: { id: string; name: string },
) {
  const c = editor.chain().focus();
  if (range) c.deleteRange(range);
  c.insertContent([
    { type: 'text', text: page.name, marks: [{ type: 'link', attrs: { href: pagePath(page) } }] },
    { type: 'text', text: ' ' },
  ]).run();
}

const GROUP_KEY: Record<string, WebKey> = {
  people: 'wiki.mention.people',
  pages: 'wiki.mention.pages',
  dates: 'wiki.mention.dates',
};

export function SuggestMenu({ host }: { host: EditorHost }) {
  const { t, locale } = useI18n();
  const s = useSyncExternalStore(suggestStore.subscribe, suggestStore.get, () => null);
  const listRef = useRef<HTMLDivElement>(null);

  const entries: Entry[] = useMemo(() => {
    if (!s) return [];
    const q = fold(s.query);
    const pageEntries: Entry[] = host.pages
      .filter((p) => !q || fold(p.name).includes(q))
      .slice(0, 8)
      .map((p) => ({
        id: `page:${p.id}`,
        icon: 'page',
        label: p.name,
        group: 'pages',
        run: (e: Editor, r: Range) =>
          s.kind === 'pageLink'
            ? insertPageLink(e, r, p)
            : e
                .chain()
                .focus()
                .deleteRange(r)
                .insertContent([
                  { type: 'mention', attrs: { id: p.id, label: p.name, kind: 'node' } },
                  { type: 'text', text: ' ' },
                ])
                .run(),
      }));
    if (s.kind === 'pageLink') return pageEntries;
    const people: Entry[] = host.people
      .filter(
        (m) =>
          m.status === 'active' &&
          (!q || fold(m.user.name).includes(q) || fold(m.user.email).includes(q)),
      )
      .slice(0, 8)
      .map((m) => ({
        id: `user:${m.user.id}`,
        icon: 'user',
        label: m.user.name,
        hint: host.spaceMemberIds.has(m.user.id) ? m.user.email : t('wiki.mention.noAccess'),
        group: 'people',
        run: (e: Editor, r: Range) =>
          e
            .chain()
            .focus()
            .deleteRange(r)
            .insertContent([
              { type: 'mention', attrs: { id: m.user.id, label: m.user.name, kind: 'user' } },
              { type: 'text', text: ' ' },
            ])
            .run(),
      }));
    const today = new Date();
    const dates: Entry[] = [0, 1, 7]
      .map((d) => new Date(today.getTime() + d * 86_400_000))
      .map((d, i) => ({
        id: `date:${i}`,
        icon: 'calendar' as IconName,
        label: formatDate(d, locale),
        hint: t(
          i === 0
            ? 'wiki.mention.today'
            : i === 1
              ? 'wiki.mention.tomorrow'
              : 'wiki.mention.nextWeek',
        ),
        group: 'dates',
        run: (e: Editor, r: Range) =>
          e
            .chain()
            .focus()
            .deleteRange(r)
            .insertContent([
              {
                type: 'mention',
                attrs: { id: isoDate(d), label: formatDate(d, locale), kind: 'date' },
              },
              { type: 'text', text: ' ' },
            ])
            .run(),
      }))
      .filter((x) => !q || fold(x.label).includes(q) || fold(x.hint).includes(q));
    return [...people, ...pageEntries, ...dates];
  }, [s, host, t, locale]);

  useEffect(() => {
    suggestStore.setItems(entries.map<SuggestItem>((e) => ({ id: e.id, run: e.run })));
  }, [entries]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [s?.index]);

  let lastGroup = '';
  // Under the caret, flipped and shifted at the edges, capped to the height left (doc 02 · 9.4).
  return (
    <SuggestionPanel
      open={Boolean(s?.rect)}
      onDismiss={() => suggestStore.close()}
      anchorRect={() => suggestStore.get()?.rect ?? null}
      aria-label={t('wiki.mention.title')}
      className="w-[300px] overflow-hidden p-0"
    >
      {/* The editor keeps focus while an item is clicked. */}
      <div className="flex min-h-0 flex-1 flex-col" onMouseDown={(e) => e.preventDefault()}>
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('wiki.mention.title')}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        >
          {!s ? null : entries.length === 0 ? (
            <p className="px-3 py-2 text-cap text-fg3">{t('wiki.slash.none')}</p>
          ) : (
            entries.map((e, i) => {
              const head =
                e.group !== lastGroup ? (GROUP_KEY[e.group] ? t(GROUP_KEY[e.group]!) : null) : null;
              lastGroup = e.group;
              return (
                <div key={e.id}>
                  {head ? <div className="eyebrow px-2.5 pt-2 pb-1">{head}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === s.index}
                    data-active={i === s.index}
                    onMouseEnter={() => suggestStore.setIndex(i)}
                    onClick={() => suggestStore.choose(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-[13.5px]',
                      i === s.index ? 'bg-capsule text-fg' : 'text-fg2',
                    )}
                  >
                    <Icon name={e.icon} size={16} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                    {e.hint ? <span className="truncate text-xs text-fg3">{e.hint}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex shrink-0 gap-3 border-t border-line px-3 py-1.5 text-xs text-fg3">
          <span>↑↓ {t('wiki.slash.navigate')}</span>
          <span>Enter {t('wiki.slash.insert')}</span>
          <span>Esc {t('wiki.slash.close')}</span>
        </div>
      </div>
    </SuggestionPanel>
  );
}

/** Local calendar date as `YYYY-MM-DD` (the date mention's id). */
function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
