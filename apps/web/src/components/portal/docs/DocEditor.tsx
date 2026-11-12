import { type PortalDoc, type UpdatePortalDoc } from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Segmented,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { docQuery, invalidatePortal } from '@/lib/portal/api';
import { useAutosave } from '@/lib/portal/autosave';
import { usePortalSite } from '@/lib/portal/context';
import { localeName, localeTag } from '@/lib/portal/format';
import {
  ConfirmDialog,
  Counter,
  FieldRow,
  PrefixedInput,
  SaveStatus,
  smallInput,
  StatusChip,
} from '@/components/portal/common';
import { PortalEditor } from '@/components/portal/PortalEditor';

type Patch = Omit<UpdatePortalDoc, 'baseRev'>;

/** Saves a doc draft and keeps the cached doc, tree and queue in step. */
export function useDocAutosave(doc: PortalDoc) {
  const qc = useQueryClient();
  const save = useCallback(
    async (patch: Patch, baseRev: number) => {
      const d = await api.call('updatePortalDoc', {
        params: { docId: doc.id },
        body: { ...patch, baseRev },
      });
      qc.setQueryData(docQuery(doc.id).queryKey, d);
      invalidatePortal(qc);
      return d.rev;
    },
    [doc.id, qc],
  );
  return useAutosave<Patch>({ rev: doc.rev, save });
}

/** Banner after a 409: someone else saved; reload to continue (design 10.2). */
export function ConflictBanner({ onReload }: { onReload: () => void }) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-4 py-3 text-sm"
    >
      <Icon name="alert" size={18} className="shrink-0 text-danger" />
      <span className="flex-1">{t('portal.docs.conflict')}</span>
      <Button size="xs" variant="inv" onClick={onReload}>
        {t('portal.docs.reload')}
      </Button>
    </div>
  );
}

/** Language switch of the editor toolbar: "EN", "TR yok". */
export function LocaleSwitch({
  doc,
  onLocale,
}: {
  doc: Pick<PortalDoc, 'locale' | 'translations'>;
  onLocale: (l: string) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div
      role="group"
      aria-label={t('portal.docs.language')}
      className="flex gap-0.5 rounded-md bg-bg2 p-[3px]"
    >
      {doc.translations.map((tr) => {
        const missing = tr.state === 'missing';
        return (
          <button
            key={tr.locale}
            type="button"
            aria-pressed={tr.locale === doc.locale}
            aria-label={localeName(tr.locale, locale)}
            onClick={() => onLocale(tr.locale)}
            className={cn(
              'flex h-[26px] items-center gap-1 rounded-sm px-2 text-xs font-semibold text-fg2',
              tr.locale === doc.locale && 'bg-surface text-fg shadow-sm dark:bg-capsule',
            )}
          >
            {localeTag(tr.locale)}
            {missing ? <span className="font-normal text-fg3">{t('portal.docs.none')}</span> : null}
            {tr.state === 'outdated' ? <span className="size-1.5 rounded-full bg-warning" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 10.2 editor pane for a doc: front matter fields, the block editor, autosave with the
 * revision check, "next'e de uygula", language switch, delete / restore.
 */
export function DocEditor({
  doc,
  hasNext,
  onLocale,
  onTranslate,
  onReload,
  onDeleted,
}: {
  doc: PortalDoc;
  hasNext: boolean;
  onLocale: (l: string) => void;
  onTranslate: () => void;
  onReload: () => void;
  onDeleted: () => void;
}) {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const autosave = useDocAutosave(doc);
  const segments = doc.slug.split('/');
  const prefix = segments.length > 1 ? `…/${segments.slice(-2, -1)[0]}/` : '/';
  const [title, setTitle] = useState(doc.title);
  const [slugLast, setSlugLast] = useState(segments[segments.length - 1] ?? '');
  const [position, setPosition] = useState(String(doc.position));
  const [label, setLabel] = useState(doc.sidebarLabel ?? '');
  const [description, setDescription] = useState(doc.description ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canEdit = site.capabilities.edit && doc.status !== 'removed';
  const slugError = isApiError(autosave.error, 'portal_slug_taken');
  const isSource = doc.locale === site.defaultLocale;

  const applyNext = useMutation({
    mutationFn: async () => {
      await autosave.flush();
      return api.call('applyPortalDocToNext', { params: { docId: doc.id } });
    },
    onSuccess: () => {
      invalidatePortal(qc);
      toast(t('portal.docs.appliedToNext'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const restore = useMutation({
    mutationFn: () => api.call('restorePortalDoc', { params: { docId: doc.id } }),
    onSuccess: (d) => {
      qc.setQueryData(docQuery(d.id).queryKey, d);
      invalidatePortal(qc);
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const copyMarkdown = async () => {
    try {
      await autosave.flush();
      const { markdown } = await api.call('getPortalDocMarkdown', { params: { docId: doc.id } });
      await navigator.clipboard.writeText(markdown);
      toast(t('portal.common.copied'));
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-bg px-6">
        <StatusChip status={doc.status} />
        <SaveStatus state={autosave.state} savedAt={autosave.savedAt} />
        {hasNext && doc.versionStatus === 'current' && canEdit ? (
          <Button
            size="xs"
            variant="gh"
            loading={applyNext.isPending}
            onClick={() => applyNext.mutate()}
          >
            <Icon name="arrowR" size={14} />
            {t('portal.docs.applyToNext')}
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {doc.translation === 'outdated' ? (
            <Button size="xs" variant="out" onClick={onTranslate}>
              <span className="size-1.5 rounded-full bg-warning" />
              {t('portal.translate.outdated')}
            </Button>
          ) : null}
          <LocaleSwitch doc={doc} onLocale={onLocale} />
          <Menu>
            <MenuTrigger asChild>
              <IconButton aria-label={t('portal.docs.more')} size="sm" shape="sq" tone="plain">
                <Icon name="dots" size={16} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              {!isSource ? (
                <MenuItem icon="lang" onSelect={onTranslate}>
                  {t('portal.docs.translationView')}
                </MenuItem>
              ) : null}
              <MenuItem icon="copy" onSelect={() => void copyMarkdown()}>
                {t('portal.docs.copyMarkdown')}
              </MenuItem>
              {site.capabilities.edit ? (
                <>
                  <MenuSeparator />
                  {doc.status === 'removed' ? (
                    <MenuItem icon="undo" onSelect={() => restore.mutate()}>
                      {t('portal.common.restore')}
                    </MenuItem>
                  ) : (
                    <MenuItem icon="trash" danger onSelect={() => setConfirmDelete(true)}>
                      {t('portal.common.delete')}
                    </MenuItem>
                  )}
                </>
              ) : null}
            </MenuContent>
          </Menu>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-5 px-8 py-6">
        {autosave.state === 'conflict' ? <ConflictBanner onReload={onReload} /> : null}
        {doc.status === 'removed' ? (
          <div className="flex items-center gap-3 rounded-xl bg-bg2 px-4 py-3 text-sm">
            <Icon name="trash" size={18} className="text-fg2" />
            <span className="flex-1">{t('portal.docs.removedNote')}</span>
            {site.capabilities.edit ? (
              <Button
                size="xs"
                variant="inv"
                onClick={() => restore.mutate()}
                loading={restore.isPending}
              >
                {t('portal.common.restore')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {doc.versionStatus === 'archived' ? (
          <p className="flex items-center gap-2 rounded-xl bg-bg2 px-4 py-2.5 text-xs text-fg2">
            <Icon name="lock" size={14} />
            {t('portal.docs.archivedNote', { version: doc.version })}
          </p>
        ) : null}
        <div className="grid grid-cols-[minmax(0,2fr)_120px_minmax(0,1.4fr)] gap-3">
          <FieldRow className="col-span-3" label={t('portal.docs.title')} htmlFor="doc-title">
            <input
              id="doc-title"
              value={title}
              disabled={!canEdit}
              onChange={(e) => {
                setTitle(e.target.value);
                if (e.target.value.trim()) autosave.queue({ title: e.target.value });
              }}
              className={cn(smallInput, 'font-semibold')}
              placeholder={t('portal.docs.titlePlaceholder')}
            />
          </FieldRow>
          <FieldRow label={t('portal.docs.slug')} htmlFor="doc-slug">
            <PrefixedInput
              id="doc-slug"
              prefix={prefix}
              value={slugLast}
              disabled={!canEdit}
              aria-invalid={slugError || undefined}
              onChange={(e) => {
                const v = e.target.value.replace(/[^A-Za-z0-9._-]/g, '-');
                setSlugLast(v);
                if (v) autosave.queue({ slug: [...segments.slice(0, -1), v].join('/') });
              }}
            />
          </FieldRow>
          <FieldRow label={t('portal.docs.position')} htmlFor="doc-pos">
            <input
              id="doc-pos"
              type="number"
              className={smallInput}
              value={position}
              disabled={!canEdit}
              onChange={(e) => {
                setPosition(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== '' && Number.isFinite(n)) autosave.queue({ position: n });
              }}
            />
          </FieldRow>
          <FieldRow label={t('portal.docs.sidebarLabel')} htmlFor="doc-label">
            <input
              id="doc-label"
              className={smallInput}
              value={label}
              placeholder={title}
              disabled={!canEdit}
              onChange={(e) => {
                setLabel(e.target.value);
                autosave.queue({ sidebarLabel: e.target.value || null });
              }}
            />
          </FieldRow>
          {slugError ? (
            <span role="alert" className="col-span-3 -mt-1 text-xs text-danger">
              {t('errors.portal_slug_taken')}
            </span>
          ) : null}
          <FieldRow
            className="col-span-3"
            label={t('portal.docs.description')}
            htmlFor="doc-desc"
            aside={<Counter value={description} max={160} />}
          >
            <input
              id="doc-desc"
              className={smallInput}
              value={description}
              disabled={!canEdit}
              onChange={(e) => {
                setDescription(e.target.value);
                autosave.queue({ description: e.target.value || null });
              }}
            />
          </FieldRow>
        </div>
        <PortalEditor
          key={`${doc.id}`}
          siteId={site.id}
          value={doc.content}
          editable={canEdit && autosave.state !== 'conflict'}
          onChange={(content) => autosave.queue({ content })}
        />
        <p className="text-xs text-fg3">
          {t('portal.docs.footer', {
            count: doc.wordCount,
            language: localeName(doc.locale, locale),
            version: doc.version,
          })}
        </p>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title={t('portal.docs.deleteTitle', { title: doc.title })}
        description={
          doc.published
            ? t('portal.docs.deletePublished')
            : isSource
              ? t('portal.docs.deleteDraft')
              : t('portal.docs.deleteTranslation')
        }
        confirm={t('portal.common.delete')}
        onConfirm={async () => {
          try {
            await api.call('deletePortalDoc', { params: { docId: doc.id } });
            invalidatePortal(qc);
            if (doc.published) {
              void qc.invalidateQueries({ queryKey: docQuery(doc.id).queryKey });
            } else onDeleted();
          } catch (e) {
            toast(t(errorKey(e)));
          }
        }}
      />
    </div>
  );
}

/** Category (Docusaurus `_category_.json`): label, slug, position, link type, description. */
export function CategoryEditor({
  doc,
  onLocale,
  onReload,
  onDeleted,
}: {
  doc: PortalDoc;
  onLocale: (l: string) => void;
  onReload: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const autosave = useDocAutosave(doc);
  const segments = doc.slug.split('/');
  const [title, setTitle] = useState(doc.title);
  const [slugLast, setSlugLast] = useState(segments[segments.length - 1] ?? '');
  const [position, setPosition] = useState(String(doc.position));
  const [link, setLink] = useState<'none' | 'generated-index'>(
    doc.categoryLink === 'none' ? 'none' : 'generated-index',
  );
  const [description, setDescription] = useState(doc.description ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canEdit = site.capabilities.edit && doc.status !== 'removed';
  const isSource = doc.locale === site.defaultLocale;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-6">
        <Badge>{t('portal.kind.category')}</Badge>
        <StatusChip status={doc.status} />
        <SaveStatus state={autosave.state} savedAt={autosave.savedAt} />
        <div className="ml-auto flex items-center gap-2">
          <LocaleSwitch doc={doc} onLocale={onLocale} />
          {site.capabilities.edit && doc.status !== 'removed' ? (
            <Button size="xs" variant="dng" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={14} />
              {t('portal.common.delete')}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-8 py-6">
        {autosave.state === 'conflict' ? <ConflictBanner onReload={onReload} /> : null}
        <h2 className="m-0 text-title font-bold">{title || doc.title}</h2>
        <FieldRow label={t('portal.docs.categoryLabel')} htmlFor="cat-title">
          <input
            id="cat-title"
            className={smallInput}
            value={title}
            disabled={!canEdit}
            onChange={(e) => {
              setTitle(e.target.value);
              if (e.target.value.trim()) autosave.queue({ title: e.target.value });
            }}
          />
        </FieldRow>
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <FieldRow label={t('portal.docs.slug')} htmlFor="cat-slug">
            <PrefixedInput
              id="cat-slug"
              prefix={segments.length > 1 ? `…/${segments.slice(-2, -1)[0]}/` : '/'}
              value={slugLast}
              disabled={!canEdit || !isSource}
              onChange={(e) => {
                const v = e.target.value.replace(/[^A-Za-z0-9._-]/g, '-');
                setSlugLast(v);
                if (v) autosave.queue({ slug: [...segments.slice(0, -1), v].join('/') });
              }}
            />
          </FieldRow>
          <FieldRow label={t('portal.docs.position')} htmlFor="cat-pos">
            <input
              id="cat-pos"
              type="number"
              className={smallInput}
              value={position}
              disabled={!canEdit}
              onChange={(e) => {
                setPosition(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== '' && Number.isFinite(n)) autosave.queue({ position: n });
              }}
            />
          </FieldRow>
        </div>
        <FieldRow label={t('portal.docs.categoryLink')}>
          <Segmented
            aria-label={t('portal.docs.categoryLink')}
            value={link}
            onValueChange={(v) => {
              setLink(v);
              autosave.queue({ categoryLink: v });
            }}
            options={[
              { value: 'generated-index', label: t('portal.docs.linkIndex'), disabled: !canEdit },
              { value: 'none', label: t('portal.docs.linkNone'), disabled: !canEdit },
            ]}
          />
        </FieldRow>
        {link === 'generated-index' && doc.categorySlug ? (
          <p className="text-xs text-fg2">
            {t('portal.docs.indexPath', { path: `/docs/${doc.version}/${doc.categorySlug}` })}
          </p>
        ) : null}
        <FieldRow
          label={t('portal.docs.categoryDescription')}
          htmlFor="cat-desc"
          aside={<Counter value={description} max={160} />}
        >
          <textarea
            id="cat-desc"
            className={cn(smallInput, 'h-auto min-h-20 py-2')}
            value={description}
            disabled={!canEdit}
            onChange={(e) => {
              setDescription(e.target.value);
              autosave.queue({ description: e.target.value || null });
            }}
          />
        </FieldRow>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title={t('portal.docs.deleteTitle', { title: doc.title })}
        description={t('portal.docs.deleteCategory')}
        confirm={t('portal.common.delete')}
        onConfirm={async () => {
          try {
            await api.call('deletePortalDoc', { params: { docId: doc.id } });
            invalidatePortal(qc);
            if (doc.published) void qc.invalidateQueries({ queryKey: docQuery(doc.id).queryKey });
            else onDeleted();
          } catch (e) {
            toast(t(errorKey(e)));
          }
        }}
      />
    </div>
  );
}
