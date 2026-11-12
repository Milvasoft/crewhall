import { type PortalTreeItem } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { docQuery, invalidatePortal, treeQuery, versionsQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { docPath, localeName } from '@/lib/portal/format';
import { PortalPage } from '@/components/portal/PortalPage';
import { CategoryEditor, DocEditor } from './DocEditor';
import { DocTree } from './DocTree';
import { TranslationView } from './TranslationView';

const ROUTE = '/_app/portal/$siteSlug/docs/' as const;

/** 10.2 / 10.3: doc tree on the left, the doc, category or translation view on the right. */
export function DocsScreen() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const search = useSearch({ from: ROUTE });
  const navigate = useNavigate();
  const versions = useQuery(versionsQuery(site.id));
  const version = search.v ?? site.currentVersion ?? 'next';
  const locale = search.l ?? site.defaultLocale;
  const tree = useQuery(treeQuery(site.id, version, locale));
  const items = tree.data?.items ?? [];
  const item = items.find((i) => i.groupId === search.g);
  const doc = useQuery({ ...docQuery(item?.id ?? ''), enabled: Boolean(item?.id) });
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState<'doc' | 'category' | null>(null);

  const setSearch = (patch: Partial<typeof search>, replace = false) =>
    void navigate({
      to: '/portal/$siteSlug/docs',
      params: { siteSlug: site.slug },
      search: (prev) => ({ ...prev, ...patch }),
      replace,
    });

  // ?doc=<id> (links from other screens): open its version, language and group.
  const linked = useQuery({ ...docQuery(search.doc ?? ''), enabled: Boolean(search.doc) });
  useEffect(() => {
    const d = linked.data;
    if (d && search.doc) {
      void navigate({
        to: '/portal/$siteSlug/docs',
        params: { siteSlug: site.slug },
        search: { v: d.version, l: d.locale, g: d.groupId },
        replace: true,
      });
    }
  }, [linked.data, search.doc, navigate, site.slug]);

  const reloadDoc = async () => {
    if (item?.id) await qc.invalidateQueries({ queryKey: docQuery(item.id).queryKey });
    setReload((r) => r + 1);
  };

  const d = doc.data;
  const crumbs = [
    { label: t('portal.nav.docs') },
    ...(d ? d.path.map((p) => ({ label: p.title })) : []),
    ...(d
      ? [{ label: search.translate ? t('portal.translate.crumb', { title: d.title }) : d.title }]
      : []),
  ];
  const hasNext = Boolean(versions.data?.items.some((v) => v.status === 'next'));

  let main: React.ReactNode;
  if (!item) {
    main = (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon="page"
          title={t('portal.docs.pickTitle')}
          description={t('portal.docs.pickBody')}
        >
          <Button variant="out" size="sm" asChild>
            <Link to="/portal/$siteSlug/docs/versions" params={{ siteSlug: site.slug }}>
              <Icon name="layers" size={16} />
              {t('portal.nav.versions')}
            </Link>
          </Button>
        </EmptyState>
      </div>
    );
  } else if (item.id === null) {
    main = (
      <MissingTranslation
        item={item}
        version={version}
        locale={locale}
        onLocale={(l) => setSearch({ l })}
      />
    );
  } else if (!d) {
    main = (
      <div className="flex flex-1 flex-col gap-3 p-8">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  } else if (search.translate && d.source) {
    main = (
      <TranslationView
        key={`${d.id}:${reload}`}
        doc={d}
        onClose={() => setSearch({ translate: undefined })}
        onReload={() => void reloadDoc()}
      />
    );
  } else if (d.kind === 'category') {
    main = (
      <CategoryEditor
        key={`${d.id}:${reload}`}
        doc={d}
        onLocale={(l) => setSearch({ l })}
        onReload={() => void reloadDoc()}
        onDeleted={() => setSearch({ g: undefined })}
      />
    );
  } else {
    main = (
      <DocEditor
        key={`${d.id}:${reload}`}
        doc={d}
        hasNext={hasNext}
        onLocale={(l) => setSearch({ l })}
        onTranslate={() => setSearch({ translate: true })}
        onReload={() => void reloadDoc()}
        onDeleted={() => setSearch({ g: undefined })}
      />
    );
  }

  return (
    <PortalPage
      crumbs={crumbs}
      previewPath={d ? docPath(site, d) : null}
      bodyClassName="flex-row gap-0 p-0 overflow-hidden"
    >
      <DocTree
        items={items}
        loading={tree.isPending}
        versions={versions.data?.items ?? []}
        version={version}
        locale={locale}
        selected={search.g}
        onSelect={(g) => setSearch({ g, translate: undefined })}
        onVersion={(v) => setSearch({ v, g: undefined, translate: undefined })}
        onLocale={(l) => setSearch({ l })}
        onNew={setCreating}
        onMoved={(g) => {
          if (g === search.g) void reloadDoc();
        }}
      />
      {main}
      {creating ? (
        <NewDocDialog
          kind={creating}
          version={version}
          categories={items.filter((i) => i.kind === 'category')}
          parent={item ? (item.kind === 'category' ? item.groupId : item.parentGroupId) : null}
          onClose={() => setCreating(null)}
          onCreated={(g) => {
            setCreating(null);
            setSearch({ g, l: site.defaultLocale, translate: undefined });
          }}
        />
      ) : null}
    </PortalPage>
  );
}

/** Tree item without a doc in this language: "TR yok" + "Çeviriyi başlat". */
function MissingTranslation({
  item,
  version,
  locale,
  onLocale,
}: {
  item: PortalTreeItem;
  version: string;
  locale: string;
  onLocale: (l: string) => void;
}) {
  const { t, locale: ui } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (copySource: boolean) =>
      api.call('createPortalDoc', {
        params: { siteId: site.id },
        body: {
          kind: item.kind,
          version,
          locale,
          translationOf: item.sourceId,
          title: item.title,
          copySource,
        },
      }),
    onSuccess: (d) => {
      qc.setQueryData(docQuery(d.id).queryKey, d);
      invalidatePortal(qc);
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const language = localeName(locale, ui);
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon="lang"
        title={t('portal.docs.missingTitle', { language, title: item.title })}
        description={t('portal.docs.missingBody', {
          language,
          current: localeName(site.defaultLocale, ui),
        })}
      >
        {site.capabilities.edit ? (
          <>
            <Button
              variant="inv"
              size="sm"
              loading={create.isPending}
              onClick={() => create.mutate(true)}
            >
              {t('portal.docs.startTranslation')}
            </Button>
            <Button variant="gh" size="sm" onClick={() => create.mutate(false)}>
              {t('portal.docs.startEmpty')}
            </Button>
          </>
        ) : null}
        <Button variant="gh" size="sm" onClick={() => onLocale(site.defaultLocale)}>
          {t('portal.docs.openSource', { language: localeName(site.defaultLocale, ui) })}
        </Button>
      </EmptyState>
    </div>
  );
}

function NewDocDialog({
  kind: initialKind,
  version,
  categories,
  parent,
  onClose,
  onCreated,
}: {
  kind: 'doc' | 'category';
  version: string;
  categories: PortalTreeItem[];
  parent: string | null;
  onClose: () => void;
  onCreated: (groupId: string) => void;
}) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const [kind, setKind] = useState(initialKind);
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState<string>(parent ?? 'root');
  const create = useMutation({
    mutationFn: () =>
      api.call('createPortalDoc', {
        params: { siteId: site.id },
        body: {
          kind,
          version,
          locale: site.defaultLocale,
          parentGroupId: parentId === 'root' ? null : parentId,
          title: title.trim(),
        },
      }),
    onSuccess: (d) => {
      qc.setQueryData(docQuery(d.id).queryKey, d);
      invalidatePortal(qc);
      onCreated(d.groupId);
    },
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent width={460}>
        <DialogHeader
          icon={kind === 'doc' ? 'page' : 'folder'}
          title={t(kind === 'doc' ? 'portal.docs.newDoc' : 'portal.docs.newCategory')}
          description={t('portal.docs.newHint', { version })}
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <Segmented
            aria-label={t('portal.docs.kind')}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'doc', label: t('portal.kind.doc'), icon: 'page' },
              { value: 'category', label: t('portal.kind.category'), icon: 'folder' },
            ]}
          />
          <Field
            label={t('portal.docs.title')}
            error={create.error ? t(errorKey(create.error)) : undefined}
          >
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label={t('portal.docs.parent')}>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger aria-label={t('portal.docs.parent')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="root">{t('portal.docs.root')}</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.groupId} value={c.groupId}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="gh" size="sm" onClick={onClose}>
              {t('portal.common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="inv"
              size="sm"
              disabled={!title.trim()}
              loading={create.isPending}
            >
              {t('portal.common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
