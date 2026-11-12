import { type PortalHome, type PortalHomeSection } from '@crewhall/shared';
import {
  Badge,
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
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { homeQuery, invalidatePortal } from '@/lib/portal/api';
import { useAutosave } from '@/lib/portal/autosave';
import { usePortalSite } from '@/lib/portal/context';
import { localeName, localeTag } from '@/lib/portal/format';
import { Counter, FieldRow, PageHeader, SaveStatus, smallInput } from './common';
import { ImageField } from './MediaPicker';
import { PortalPage } from './PortalPage';

type SectionType = PortalHomeSection['type'];
const TYPES: SectionType[] = [
  'hero',
  'about',
  'video',
  'features',
  'technologies',
  'community',
  'projects',
  'markdown',
];

/** Which fields each section type edits; layout and animation stay in the site's code. */
const FIELDS: Record<
  SectionType,
  ('description' | 'badge' | 'items' | 'image' | 'imageDark' | 'images' | 'videoId' | 'projects')[]
> = {
  hero: ['badge', 'description', 'image', 'imageDark'],
  about: ['description', 'image'],
  video: ['videoId'],
  features: ['items', 'image'],
  technologies: ['images'],
  community: ['description', 'image'],
  projects: ['projects'],
  markdown: ['description'],
};

/** 10.8 Home page: sections (order, hide, add) and a per-language form for the open one. */
export function HomeEditor() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const home = useQuery(homeQuery(site.id));
  return (
    <PortalPage crumbs={[{ label: t('portal.nav.home') }]} previewPath="/">
      {home.data ? (
        <HomeForm initial={home.data.draft} changed={home.data.changed} />
      ) : (
        <Skeleton className="h-64 rounded-2xl" />
      )}
    </PortalPage>
  );
}

function HomeForm({ initial, changed }: { initial: PortalHome; changed: boolean }) {
  const { t, locale: ui } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/portal/$siteSlug/home' });
  const lang = search.lang && site.locales.includes(search.lang) ? search.lang : site.defaultLocale;
  const [draft, setDraft] = useState(initial);
  const [dragging, setDragging] = useState<number | null>(null);
  const selectedId = search.section ?? draft.sections[0]?.id;
  const section = draft.sections.find((s) => s.id === selectedId);
  const canEdit = site.capabilities.edit;

  const save = useCallback(
    async (patch: { home: PortalHome }) => {
      const state = await api.call('updatePortalHome', {
        params: { siteId: site.id },
        body: patch.home,
      });
      qc.setQueryData(homeQuery(site.id).queryKey, state);
      invalidatePortal(qc);
      return 0;
    },
    [qc, site.id],
  );
  const autosave = useAutosave<{ home: PortalHome }>({ rev: 0, save });
  const commit = (next: PortalHome) => {
    setDraft(next);
    autosave.queue({ home: next });
  };
  const setSearch = (patch: { lang?: string; section?: string }) =>
    void navigate({
      to: '/portal/$siteSlug/home',
      params: { siteSlug: site.slug },
      search: (prev) => ({ ...prev, ...patch }),
      replace: true,
    });
  const updateSection = (id: string, patch: Partial<PortalHomeSection>) =>
    commit({ sections: draft.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const moveSection = (from: number, to: number) => {
    if (to < 0 || to >= draft.sections.length || from === to) return;
    const list = [...draft.sections];
    const [it] = list.splice(from, 1);
    if (it) list.splice(to, 0, it);
    commit({ sections: list });
  };
  const addSection = (type: SectionType) => {
    let id: string = type;
    for (let i = 2; draft.sections.some((s) => s.id === id); i++) id = `${type}-${i}`;
    commit({ sections: [...draft.sections, { id, type, hidden: false, title: {} }] });
    setSearch({ section: id });
  };
  const title = (s: PortalHomeSection) =>
    s.title[lang] || s.title[site.defaultLocale] || t(`portal.home.types.${s.type}`);

  return (
    <>
      <PageHeader
        title={t('portal.nav.home')}
        subtitle={t('portal.home.subtitle')}
        actions={
          <>
            <SaveStatus state={autosave.state} savedAt={autosave.savedAt} />
            {changed ? <Badge tone="warn">{t('portal.status.changed')}</Badge> : null}
          </>
        }
      />
      <Segmented
        aria-label={t('portal.docs.language')}
        className="w-fit"
        value={lang}
        onValueChange={(l) => setSearch({ lang: l })}
        options={site.locales.map((l) => ({
          value: l,
          label: `${localeTag(l)} · ${localeName(l, ui)}`,
        }))}
      />
      <div className="grid min-h-0 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <section
          aria-label={t('portal.home.sections')}
          className="flex flex-col gap-2 rounded-2xl bg-surface p-3 shadow-line"
        >
          <div className="flex items-center justify-between px-2 pt-1">
            <h2 className="m-0 text-sub font-semibold">{t('portal.home.sections')}</h2>
            {canEdit ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="xs" variant="out">
                    <Icon name="plus" size={14} />
                    {t('portal.home.add')}
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {TYPES.map((type) => (
                    <MenuItem key={type} onSelect={() => addSection(type)}>
                      {t(`portal.home.types.${type}`)}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            ) : null}
          </div>
          <ul className="flex flex-col gap-1">
            {draft.sections.map((s, i) => (
              <li
                key={s.id}
                draggable={canEdit}
                onDragStart={() => setDragging(i)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => dragging !== null && e.preventDefault()}
                onDrop={() => {
                  if (dragging !== null) moveSection(dragging, i);
                  setDragging(null);
                }}
                className={cn(
                  'group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-bg2',
                  s.id === selectedId && 'bg-capsule hover:bg-capsule',
                  s.hidden && 'opacity-55',
                  dragging === i && 'opacity-40',
                )}
              >
                <Icon name="grip" size={14} className="shrink-0 cursor-grab text-fg3" />
                <button
                  type="button"
                  onClick={() => setSearch({ section: s.id })}
                  className="flex min-w-0 flex-1 flex-col text-left"
                >
                  <span className="truncate text-[13.5px] font-semibold">{title(s)}</span>
                  <span className="truncate text-xs text-fg2">
                    {t(`portal.home.types.${s.type}`)}
                  </span>
                </button>
                {canEdit ? (
                  <span className="flex shrink-0 items-center">
                    <IconButton
                      aria-label={t('portal.common.moveUp')}
                      size="xs"
                      tone="plain"
                      disabled={i === 0}
                      onClick={() => moveSection(i, i - 1)}
                    >
                      <Icon name="chevU" size={14} />
                    </IconButton>
                    <IconButton
                      aria-label={t('portal.common.moveDown')}
                      size="xs"
                      tone="plain"
                      disabled={i === draft.sections.length - 1}
                      onClick={() => moveSection(i, i + 1)}
                    >
                      <Icon name="chevD" size={14} />
                    </IconButton>
                    <IconButton
                      aria-label={t(s.hidden ? 'portal.home.show' : 'portal.home.hide', {
                        name: title(s),
                      })}
                      aria-pressed={!s.hidden}
                      size="xs"
                      tone="plain"
                      onClick={() => updateSection(s.id, { hidden: !s.hidden })}
                    >
                      <Icon name={s.hidden ? 'eyeOff' : 'eye'} size={14} />
                    </IconButton>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section
          aria-label={t('portal.home.form')}
          className="flex min-w-0 flex-col gap-4 rounded-2xl bg-surface p-5 shadow-line"
        >
          {!section ? (
            <EmptyState icon="home" title={t('portal.home.pick')} />
          ) : (
            <SectionForm
              key={`${section.id}:${lang}`}
              section={section}
              lang={lang}
              disabled={!canEdit}
              onChange={(patch) => updateSection(section.id, patch)}
              onRemove={() => {
                commit({ sections: draft.sections.filter((s) => s.id !== section.id) });
                setSearch({ section: undefined });
              }}
            />
          )}
        </section>
      </div>
    </>
  );
}

function SectionForm({
  section,
  lang,
  disabled,
  onChange,
  onRemove,
}: {
  section: PortalHomeSection;
  lang: string;
  disabled: boolean;
  onChange: (patch: Partial<PortalHomeSection>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const fields = FIELDS[section.type];
  const fallback = site.defaultLocale;
  const text = (value: Record<string, string> | undefined) => value?.[lang] ?? '';
  const ph = (value: Record<string, string> | undefined) =>
    lang !== fallback ? (value?.[fallback] ?? '') : '';
  const setText = (key: 'title' | 'description' | 'badge', v: string) =>
    onChange({ [key]: { ...(section[key] ?? {}), [lang]: v } });

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-h font-bold">{t(`portal.home.types.${section.type}`)}</h2>
        {!disabled ? (
          <Button size="xs" variant="dng" onClick={onRemove}>
            <Icon name="trash" size={14} />
            {t('portal.home.remove')}
          </Button>
        ) : null}
      </div>
      <FieldRow
        label={t('portal.home.title')}
        htmlFor="sec-title"
        aside={<Counter value={text(section.title)} max={60} />}
      >
        <input
          id="sec-title"
          className={smallInput}
          value={text(section.title)}
          placeholder={ph(section.title)}
          disabled={disabled}
          onChange={(e) => setText('title', e.target.value)}
        />
      </FieldRow>
      {fields.includes('badge') ? (
        <FieldRow
          label={t('portal.home.badge')}
          htmlFor="sec-badge"
          aside={<span className="font-mono text-xs text-fg3">{'{version}'}</span>}
        >
          <input
            id="sec-badge"
            className={smallInput}
            value={text(section.badge)}
            placeholder={ph(section.badge)}
            disabled={disabled}
            onChange={(e) => setText('badge', e.target.value)}
          />
          <span className="text-xs text-fg2">
            {t('portal.home.badgeHint', { version: site.currentVersion ?? '' })}
          </span>
        </FieldRow>
      ) : null}
      {fields.includes('description') ? (
        <FieldRow
          label={
            section.type === 'markdown' ? t('portal.home.markdown') : t('portal.home.description')
          }
          htmlFor="sec-desc"
          aside={
            section.type === 'markdown' ? undefined : (
              <Counter value={text(section.description)} max={240} />
            )
          }
        >
          <textarea
            id="sec-desc"
            className={cn(
              smallInput,
              'h-auto min-h-24 py-2',
              section.type === 'markdown' && 'min-h-48 font-mono',
            )}
            value={text(section.description)}
            placeholder={ph(section.description)}
            disabled={disabled}
            onChange={(e) => setText('description', e.target.value)}
          />
        </FieldRow>
      ) : null}
      {fields.includes('items') ? (
        <FieldRow label={t('portal.home.items')} htmlFor="sec-items">
          <textarea
            id="sec-items"
            className={cn(smallInput, 'h-auto min-h-24 py-2')}
            value={(section.items?.[lang] ?? []).join('\n')}
            placeholder={(section.items?.[fallback] ?? []).join('\n')}
            disabled={disabled}
            onChange={(e) =>
              onChange({ items: { ...(section.items ?? {}), [lang]: e.target.value.split('\n') } })
            }
          />
          <span className="text-xs text-fg2">{t('portal.home.itemsHint')}</span>
        </FieldRow>
      ) : null}
      {fields.includes('videoId') ? (
        <FieldRow label={t('portal.home.video')} htmlFor="sec-video">
          <input
            id="sec-video"
            className={cn(smallInput, 'font-mono')}
            value={section.videoId ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ videoId: e.target.value || null })}
          />
        </FieldRow>
      ) : null}
      {fields.includes('image') ? (
        <FieldRow label={t('portal.home.image')}>
          <ImageField
            label={t('portal.home.image')}
            value={section.image}
            disabled={disabled}
            onChange={(p) => onChange({ image: p })}
          />
        </FieldRow>
      ) : null}
      {fields.includes('imageDark') ? (
        <FieldRow label={t('portal.home.imageDark')}>
          <ImageField
            label={t('portal.home.imageDark')}
            value={section.imageDark}
            disabled={disabled}
            onChange={(p) => onChange({ imageDark: p })}
          />
        </FieldRow>
      ) : null}
      {fields.includes('images') ? (
        <FieldRow label={t('portal.home.images')}>
          <div className="flex flex-col gap-1.5">
            {(section.images ?? []).map((img, i) => (
              <ImageField
                key={`${img}-${i}`}
                label={t('portal.home.images')}
                value={img}
                disabled={disabled}
                onChange={(p) => {
                  const list = [...(section.images ?? [])];
                  if (p) list[i] = p;
                  else list.splice(i, 1);
                  onChange({ images: list });
                }}
              />
            ))}
            {!disabled ? (
              <ImageField
                label={t('portal.home.addImage')}
                value={null}
                onChange={(p) => p && onChange({ images: [...(section.images ?? []), p] })}
              />
            ) : null}
          </div>
        </FieldRow>
      ) : null}
      {fields.includes('projects') ? (
        <FieldRow label={t('portal.home.projects')}>
          <div className="flex flex-col gap-2">
            {(section.projects ?? []).map((p, i) => {
              const set = (patch: Partial<typeof p>) => {
                const list = [...(section.projects ?? [])];
                list[i] = { ...p, ...patch };
                onChange({ projects: list });
              };
              return (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_1.4fr_auto] gap-2 rounded-lg bg-bg2 p-2"
                >
                  <input
                    aria-label={t('portal.home.projectName')}
                    className={cn(smallInput, 'bg-surface')}
                    value={p.name}
                    disabled={disabled}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                  <input
                    aria-label={t('portal.home.projectUrl')}
                    className={cn(smallInput, 'bg-surface font-mono')}
                    value={p.url ?? ''}
                    disabled={disabled}
                    onChange={(e) => set({ url: e.target.value || null })}
                  />
                  <IconButton
                    aria-label={t('portal.common.remove')}
                    size="sm"
                    tone="plain"
                    disabled={disabled}
                    onClick={() =>
                      onChange({ projects: (section.projects ?? []).filter((_, j) => j !== i) })
                    }
                  >
                    <Icon name="x" size={14} />
                  </IconButton>
                  <input
                    aria-label={t('portal.home.projectDescription')}
                    className={cn(smallInput, 'col-span-3 bg-surface')}
                    value={p.description[lang] ?? ''}
                    placeholder={p.description[fallback] ?? ''}
                    disabled={disabled}
                    onChange={(e) =>
                      set({ description: { ...p.description, [lang]: e.target.value } })
                    }
                  />
                </div>
              );
            })}
            {!disabled ? (
              <Button
                size="xs"
                variant="out"
                className="w-fit"
                onClick={() =>
                  onChange({
                    projects: [
                      ...(section.projects ?? []),
                      { name: '', image: null, url: null, description: {}, badges: [] },
                    ],
                  })
                }
              >
                <Icon name="plus" size={14} />
                {t('portal.home.addProject')}
              </Button>
            ) : null}
          </div>
        </FieldRow>
      ) : null}
      {lang !== fallback ? (
        <p className="text-xs text-fg2">{t('portal.home.fallbackHint')}</p>
      ) : null}
    </>
  );
}
