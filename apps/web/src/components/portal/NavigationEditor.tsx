import { type PortalNavItem, type PortalNavigation } from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tag,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal, navigationQuery, treeQuery } from '@/lib/portal/api';
import { useAutosave } from '@/lib/portal/autosave';
import { usePortalSite } from '@/lib/portal/context';
import { localeName, localeTag } from '@/lib/portal/format';
import { Card, FieldRow, PageHeader, SaveStatus, smallInput } from './common';
import { ImageField } from './MediaPicker';
import { PortalPage } from './PortalPage';

type Kind = PortalNavItem['kind'];
const SYSTEM: Kind[] = ['localeDropdown', 'versionDropdown'];
export const isSystemItem = (it: Pick<PortalNavItem, 'kind'>) => SYSTEM.includes(it.kind);

const newId = (prefix: string, taken: string[]) => {
  let id = prefix;
  for (let i = 2; taken.includes(id); i++) id = `${prefix}-${i}`;
  return id;
};

/** 10.9 Navbar (left / right groups, system pickers only hide) and footer columns. */
export function NavigationEditor() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const nav = useQuery(navigationQuery(site.id));
  return (
    <PortalPage crumbs={[{ label: t('portal.nav.navigation') }]} previewPath="/">
      {nav.data ? (
        <NavForm initial={nav.data.draft} changed={nav.data.changed} />
      ) : (
        <Skeleton className="h-64 rounded-2xl" />
      )}
    </PortalPage>
  );
}

function NavForm({ initial, changed }: { initial: PortalNavigation; changed: boolean }) {
  const { t, locale: ui } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/portal/$siteSlug/navigation' });
  const lang = search.lang && site.locales.includes(search.lang) ? search.lang : site.defaultLocale;
  const fallback = site.defaultLocale;
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const canEdit = site.capabilities.edit;
  const docs = useQuery(treeQuery(site.id, site.currentVersion ?? 'next', site.defaultLocale));
  const docOptions = (docs.data?.items ?? []).filter((d) => d.kind === 'doc');

  const save = useCallback(
    async (patch: { nav: PortalNavigation }) => {
      const state = await api.call('updatePortalNavigation', {
        params: { siteId: site.id },
        body: patch.nav,
      });
      qc.setQueryData(navigationQuery(site.id).queryKey, state);
      invalidatePortal(qc);
      return 0;
    },
    [qc, site.id],
  );
  const autosave = useAutosave<{ nav: PortalNavigation }>({ rev: 0, save });
  const commit = (next: PortalNavigation) => {
    setDraft(next);
    autosave.queue({ nav: next });
  };
  const items = draft.navbar.items;
  const setItems = (list: PortalNavItem[]) =>
    commit({ ...draft, navbar: { ...draft.navbar, items: list } });
  const updateItem = (id: string, patch: Partial<PortalNavItem>) =>
    setItems(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const label = (v: Record<string, string>) => v[lang] || v[fallback] || '';

  const moveWithin = (id: string, dir: -1 | 1) => {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const side = items.filter((i) => i.position === it.position);
    const idx = side.indexOf(it) + dir;
    const target = side[idx];
    if (!target) return;
    const list = [...items];
    const a = list.indexOf(it);
    const b = list.indexOf(target);
    list[a] = target;
    list[b] = it;
    setItems(list);
  };
  const dropBefore = (targetId: string | null, position: 'left' | 'right') => {
    const it = items.find((i) => i.id === dragging);
    setDragging(null);
    if (!it || it.id === targetId) return;
    const rest = items.filter((i) => i.id !== it.id);
    const moved = { ...it, position };
    const at = targetId ? rest.findIndex((i) => i.id === targetId) : -1;
    if (at < 0) rest.push(moved);
    else rest.splice(at, 0, moved);
    setItems(rest);
  };
  const add = (kind: Kind) => {
    const id = newId(
      kind,
      items.map((i) => i.id),
    );
    const base: PortalNavItem = {
      id,
      kind,
      position: kind === 'link' ? 'right' : 'left',
      label: {
        [fallback]:
          kind === 'docs' ? t('portal.navEditor.kinds.docs') : kind === 'blog' ? 'Blog' : '',
      },
      href: kind === 'blog' ? '/blog' : kind === 'link' ? 'https://' : null,
      docGroupId: kind === 'doc' ? (docOptions[0]?.groupId ?? null) : null,
      hidden: false,
    };
    setItems([...items, base]);
    setEditing(id);
  };

  const renderItem = (it: PortalNavItem) => {
    const system = isSystemItem(it);
    const sub =
      it.kind === 'link' || it.kind === 'blog'
        ? (it.href ?? '')
        : it.kind === 'doc'
          ? (docOptions.find((d) => d.groupId === it.docGroupId)?.title ?? '')
          : t(`portal.navEditor.kinds.${it.kind}`);
    return (
      <li key={it.id} className="flex flex-col">
        <div
          draggable={canEdit}
          onDragStart={() => setDragging(it.id)}
          onDragEnd={() => setDragging(null)}
          onDragOver={(e) => dragging && e.preventDefault()}
          onDrop={(e) => {
            e.stopPropagation();
            dropBefore(it.id, it.position);
          }}
          aria-label={label(it.label) || t(`portal.navEditor.kinds.${it.kind}`)}
          className={cn(
            'group flex items-center gap-2 rounded-lg bg-bg2 px-2.5 py-2',
            it.hidden && 'opacity-55',
            dragging === it.id && 'opacity-40 shadow-[inset_0_0_0_1.5px_var(--fg)]',
          )}
        >
          <Icon name="grip" size={14} className="shrink-0 cursor-grab text-fg3" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13.5px] font-semibold">
              {label(it.label) || t(`portal.navEditor.kinds.${it.kind}`)}
            </span>
            <span className="truncate text-xs text-fg2">{sub}</span>
          </span>
          {system ? <Tag>{t('portal.navEditor.system')}</Tag> : null}
          {canEdit ? (
            <span className="flex shrink-0 items-center">
              <IconButton
                aria-label={t('portal.common.moveUp')}
                size="xs"
                tone="plain"
                onClick={() => moveWithin(it.id, -1)}
              >
                <Icon name="chevU" size={14} />
              </IconButton>
              <IconButton
                aria-label={t('portal.common.moveDown')}
                size="xs"
                tone="plain"
                onClick={() => moveWithin(it.id, 1)}
              >
                <Icon name="chevD" size={14} />
              </IconButton>
              <IconButton
                aria-label={t(it.hidden ? 'portal.navEditor.show' : 'portal.navEditor.hide')}
                aria-pressed={!it.hidden}
                size="xs"
                tone="plain"
                onClick={() => updateItem(it.id, { hidden: !it.hidden })}
              >
                <Icon name={it.hidden ? 'eyeOff' : 'eye'} size={14} />
              </IconButton>
              <Menu>
                <MenuTrigger asChild>
                  <IconButton
                    aria-label={t('portal.navEditor.itemMenu', {
                      name: label(it.label) || it.kind,
                    })}
                    size="xs"
                    tone="plain"
                  >
                    <Icon name="dots" size={14} />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem
                    icon="edit"
                    onSelect={() => setEditing(editing === it.id ? null : it.id)}
                  >
                    {t('portal.common.edit')}
                  </MenuItem>
                  <MenuItem
                    icon="arrowR"
                    onSelect={() =>
                      updateItem(it.id, { position: it.position === 'left' ? 'right' : 'left' })
                    }
                  >
                    {t(
                      it.position === 'left'
                        ? 'portal.navEditor.toRight'
                        : 'portal.navEditor.toLeft',
                    )}
                  </MenuItem>
                  {!system ? (
                    <MenuItem
                      icon="trash"
                      danger
                      onSelect={() => setItems(items.filter((i) => i.id !== it.id))}
                    >
                      {t('portal.common.delete')}
                    </MenuItem>
                  ) : null}
                </MenuContent>
              </Menu>
            </span>
          ) : null}
        </div>
        {editing === it.id && canEdit ? (
          <div className="mt-1 mb-2 grid grid-cols-2 gap-2 rounded-lg px-1 py-2">
            <FieldRow
              label={t('portal.navEditor.label', { language: localeTag(lang) })}
              htmlFor={`nav-${it.id}`}
            >
              <input
                id={`nav-${it.id}`}
                className={smallInput}
                value={it.label[lang] ?? ''}
                placeholder={lang !== fallback ? (it.label[fallback] ?? '') : ''}
                onChange={(e) =>
                  updateItem(it.id, { label: { ...it.label, [lang]: e.target.value } })
                }
              />
            </FieldRow>
            {it.kind === 'link' || it.kind === 'blog' ? (
              <FieldRow label={t('portal.navEditor.href')} htmlFor={`nav-href-${it.id}`}>
                <input
                  id={`nav-href-${it.id}`}
                  className={cn(smallInput, 'font-mono')}
                  value={it.href ?? ''}
                  onChange={(e) => updateItem(it.id, { href: e.target.value || null })}
                />
              </FieldRow>
            ) : it.kind === 'doc' ? (
              <FieldRow label={t('portal.navEditor.doc')}>
                <DocSelect
                  value={it.docGroupId ?? ''}
                  options={docOptions}
                  onChange={(g) => updateItem(it.id, { docGroupId: g })}
                />
              </FieldRow>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  const group = (position: 'left' | 'right') => (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">{t(`portal.navEditor.${position}`)}</span>
      <ul
        aria-label={t(`portal.navEditor.${position}`)}
        className="flex min-h-12 flex-col gap-1.5 rounded-xl p-0.5"
        onDragOver={(e) => dragging && e.preventDefault()}
        onDrop={() => dropBefore(null, position)}
      >
        {items.filter((i) => i.position === position).map(renderItem)}
      </ul>
    </div>
  );

  const columns = draft.footer.columns;
  const setColumns = (list: typeof columns) =>
    commit({ ...draft, footer: { ...draft.footer, columns: list } });

  return (
    <>
      <PageHeader
        title={t('portal.nav.navigation')}
        subtitle={t('portal.navEditor.subtitle')}
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
        onValueChange={(l) =>
          void navigate({
            to: '/portal/$siteSlug/navigation',
            params: { siteSlug: site.slug },
            search: { lang: l },
            replace: true,
          })
        }
        options={site.locales.map((l) => ({
          value: l,
          label: `${localeTag(l)} · ${localeName(l, ui)}`,
        }))}
      />
      <div
        aria-hidden
        className="flex items-center gap-4 rounded-xl bg-graphite px-4 py-2.5 text-[13px] font-semibold text-white"
      >
        <span>{label(draft.navbar.title)}</span>
        {items
          .filter((i) => i.position === 'left' && !i.hidden)
          .map((i) => (
            <span key={i.id} className="font-medium text-white/80">
              {label(i.label)}
            </span>
          ))}
        <span className="ml-auto flex gap-4">
          {items
            .filter((i) => i.position === 'right' && !i.hidden)
            .map((i) => (
              <span key={i.id} className="font-medium text-white/80">
                {i.kind === 'localeDropdown'
                  ? `${localeName(lang, ui)} ▾`
                  : i.kind === 'versionDropdown'
                    ? `${site.currentVersion ?? 'next'} ▾`
                    : label(i.label)}
              </span>
            ))}
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title={t('portal.navEditor.navbar')}
          aside={
            canEdit ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="xs" variant="out">
                    <Icon name="plus" size={14} />
                    {t('portal.navEditor.addItem')}
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {(['link', 'doc', 'blog', 'docs'] as const).map((k) => (
                    <MenuItem key={k} onSelect={() => add(k)}>
                      {t(`portal.navEditor.kinds.${k}`)}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            ) : null
          }
        >
          <div className="flex flex-col gap-4">
            {group('left')}
            {group('right')}
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">{t('portal.navEditor.titleLogo')}</span>
              <div className="grid grid-cols-2 gap-2">
                <input
                  aria-label={t('portal.navEditor.siteTitle')}
                  className={smallInput}
                  value={draft.navbar.title[lang] ?? ''}
                  placeholder={draft.navbar.title[fallback] ?? ''}
                  disabled={!canEdit}
                  onChange={(e) =>
                    commit({
                      ...draft,
                      navbar: {
                        ...draft.navbar,
                        title: { ...draft.navbar.title, [lang]: e.target.value },
                      },
                    })
                  }
                />
                <ImageField
                  label={t('portal.navEditor.logo')}
                  value={draft.navbar.logo.src}
                  disabled={!canEdit}
                  onChange={(src) =>
                    commit({
                      ...draft,
                      navbar: { ...draft.navbar, logo: { ...draft.navbar.logo, src } },
                    })
                  }
                />
              </div>
            </div>
          </div>
        </Card>
        <Card
          title={t('portal.navEditor.footer')}
          aside={
            canEdit && columns.length < 8 ? (
              <Button
                size="xs"
                variant="out"
                onClick={() =>
                  setColumns([
                    ...columns,
                    {
                      id: newId(
                        'column',
                        columns.map((c) => c.id),
                      ),
                      title: { [fallback]: '' },
                      items: [],
                    },
                  ])
                }
              >
                <Icon name="plus" size={14} />
                {t('portal.navEditor.addColumn')}
              </Button>
            ) : null
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
              {columns.map((col, ci) => {
                const setCol = (patch: Partial<typeof col>) =>
                  setColumns(columns.map((c, i) => (i === ci ? { ...c, ...patch } : c)));
                return (
                  <section
                    key={col.id}
                    aria-label={label(col.title) || t('portal.navEditor.column')}
                    className="flex flex-col gap-1.5 rounded-xl bg-bg2 p-2"
                  >
                    <div className="flex items-center gap-1">
                      <input
                        aria-label={t('portal.navEditor.columnTitle')}
                        className={cn(smallInput, 'h-8 bg-surface font-semibold')}
                        value={col.title[lang] ?? ''}
                        placeholder={col.title[fallback] ?? ''}
                        disabled={!canEdit}
                        onChange={(e) =>
                          setCol({ title: { ...col.title, [lang]: e.target.value } })
                        }
                      />
                      {canEdit ? (
                        <IconButton
                          aria-label={t('portal.navEditor.removeColumn')}
                          size="xs"
                          tone="plain"
                          onClick={() => setColumns(columns.filter((_, i) => i !== ci))}
                        >
                          <Icon name="x" size={14} />
                        </IconButton>
                      ) : null}
                    </div>
                    {col.items.map((link, li) => {
                      const setLink = (patch: Partial<typeof link>) =>
                        setCol({
                          items: col.items.map((x, i) => (i === li ? { ...x, ...patch } : x)),
                        });
                      return (
                        <div
                          key={link.id}
                          className="flex flex-col gap-1 rounded-lg bg-surface p-1.5"
                        >
                          <div className="flex items-center gap-1">
                            <input
                              aria-label={t('portal.navEditor.linkLabel')}
                              className={cn(smallInput, 'h-7 bg-transparent px-1.5 font-semibold')}
                              value={link.label[lang] ?? ''}
                              placeholder={link.label[fallback] ?? ''}
                              disabled={!canEdit}
                              onChange={(e) =>
                                setLink({ label: { ...link.label, [lang]: e.target.value } })
                              }
                            />
                            {canEdit ? (
                              <IconButton
                                aria-label={t('portal.navEditor.removeLink')}
                                size="xs"
                                tone="plain"
                                onClick={() =>
                                  setCol({ items: col.items.filter((_, i) => i !== li) })
                                }
                              >
                                <Icon name="x" size={12} />
                              </IconButton>
                            ) : null}
                          </div>
                          {link.docGroupId ? (
                            <DocSelect
                              value={link.docGroupId}
                              options={docOptions}
                              onChange={(g) => setLink({ docGroupId: g })}
                            />
                          ) : (
                            <input
                              aria-label={t('portal.navEditor.href')}
                              className={cn(
                                smallInput,
                                'h-7 bg-transparent px-1.5 font-mono text-xs',
                              )}
                              value={link.href ?? ''}
                              disabled={!canEdit}
                              onChange={(e) => setLink({ href: e.target.value || null })}
                            />
                          )}
                        </div>
                      );
                    })}
                    {canEdit ? (
                      <span className="flex gap-1">
                        <Button
                          size="xs"
                          variant="gh"
                          onClick={() =>
                            setCol({
                              items: [
                                ...col.items,
                                {
                                  id: newId(
                                    'link',
                                    col.items.map((x) => x.id),
                                  ),
                                  label: { [fallback]: '' },
                                  href: '/',
                                },
                              ],
                            })
                          }
                        >
                          {t('portal.navEditor.addLink')}
                        </Button>
                        <Button
                          size="xs"
                          variant="gh"
                          disabled={!docOptions.length}
                          onClick={() =>
                            setCol({
                              items: [
                                ...col.items,
                                {
                                  id: newId(
                                    'doc',
                                    col.items.map((x) => x.id),
                                  ),
                                  label: { [fallback]: docOptions[0]?.title ?? '' },
                                  docGroupId: docOptions[0]?.groupId ?? null,
                                },
                              ],
                            })
                          }
                        >
                          {t('portal.navEditor.addDocLink')}
                        </Button>
                      </span>
                    ) : null}
                  </section>
                );
              })}
            </div>
            <FieldRow
              label={t('portal.navEditor.copyright')}
              htmlFor="nav-copy"
              aside={
                <span className="font-mono text-xs text-fg3">
                  {t('portal.navEditor.yearHint', { year: String(new Date().getFullYear()) })}
                </span>
              }
            >
              <input
                id="nav-copy"
                className={smallInput}
                value={draft.footer.copyright[lang] ?? ''}
                placeholder={draft.footer.copyright[fallback] ?? ''}
                disabled={!canEdit}
                onChange={(e) =>
                  commit({
                    ...draft,
                    footer: {
                      ...draft.footer,
                      copyright: { ...draft.footer.copyright, [lang]: e.target.value },
                    },
                  })
                }
              />
            </FieldRow>
            <FieldRow label={t('portal.navEditor.footerStyle')}>
              <Segmented
                aria-label={t('portal.navEditor.footerStyle')}
                className="w-fit"
                value={draft.footer.style}
                onValueChange={(style) =>
                  canEdit && commit({ ...draft, footer: { ...draft.footer, style } })
                }
                options={[
                  { value: 'dark', label: t('portal.navEditor.dark') },
                  { value: 'light', label: t('portal.navEditor.light') },
                ]}
              />
            </FieldRow>
            <p className="flex gap-2 text-xs text-fg2">
              <Icon name="link" size={14} className="shrink-0" />
              {t('portal.navEditor.docLinkHint')}
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}

function DocSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { groupId: string; title: string }[];
  onChange: (groupId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={t('portal.navEditor.doc')}>
        <SelectValue placeholder={t('portal.navEditor.pickDoc')} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((d) => (
          <SelectItem key={d.groupId} value={d.groupId}>
            {d.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
