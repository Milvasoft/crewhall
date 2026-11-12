import { type PortalDoc } from '@crewhall/shared';
import { Badge, Button, Icon, Skeleton, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { docQuery, invalidatePortal } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { localeName, localeTag } from '@/lib/portal/format';
import { ConfirmDialog, LocaleTag, SaveStatus } from '@/components/portal/common';
import { PortalEditor } from '@/components/portal/PortalEditor';
import { ConflictBanner, useDocAutosave } from './DocEditor';

/**
 * 10.3 Translation view: the source language read-only on the left, the translation editable
 * on the right, the "outdated" note with dates, "Güncel olarak işaretle" and copying the source.
 * Simplified: whole documents side by side (no block alignment or word diff).
 */
export function TranslationView({
  doc,
  onClose,
  onReload,
}: {
  doc: PortalDoc;
  onClose: () => void;
  onReload: () => void;
}) {
  const { t, locale } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const source = useQuery({ ...docQuery(doc.source?.id ?? ''), enabled: Boolean(doc.source) });
  const autosave = useDocAutosave(doc);
  const [editorKey, setEditorKey] = useState(0);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const canEdit = site.capabilities.edit;
  const src = source.data;

  const markCurrent = useMutation({
    mutationFn: async () => {
      await autosave.flush();
      return api.call('markPortalTranslationCurrent', { params: { docId: doc.id } });
    },
    onSuccess: (d) => {
      qc.setQueryData(docQuery(d.id).queryKey, d);
      invalidatePortal(qc);
      toast(t('portal.translate.marked'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-6">
        <h2 className="m-0 truncate text-h font-bold">{doc.title}</h2>
        <Badge>{doc.version}</Badge>
        <LocaleTag code={site.defaultLocale} />
        <Icon name="arrowR" size={14} className="text-fg3" />
        <LocaleTag code={doc.locale} />
        <SaveStatus state={autosave.state} savedAt={autosave.savedAt} />
        <div className="ml-auto flex items-center gap-2">
          <Button size="xs" variant="gh" onClick={onClose}>
            {t('portal.translate.backToEditor')}
          </Button>
          {canEdit && doc.translation === 'outdated' ? (
            <Button
              size="xs"
              variant="out"
              loading={markCurrent.isPending}
              onClick={() => markCurrent.mutate()}
            >
              <Icon name="check" size={14} />
              {t('portal.translate.markCurrent')}
            </Button>
          ) : null}
        </div>
      </div>
      {autosave.state === 'conflict' ? (
        <div className="px-6 pt-4">
          <ConflictBanner onReload={onReload} />
        </div>
      ) : null}
      {doc.translation === 'outdated' && src ? (
        <div className="mx-6 mt-4 flex gap-2.5 rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-4 py-3 text-[13px]">
          <Icon name="alert" size={18} className="shrink-0 text-warning" />
          <p>
            {t('portal.translate.outdatedNote', {
              language: localeName(site.defaultLocale, locale),
              date: formatDate(src.updatedAt, locale, { day: 'numeric', month: 'short' }),
              name: src.updatedBy?.name ?? '',
              current: localeName(doc.locale, locale),
              when: formatDate(doc.updatedAt, locale, { day: 'numeric', month: 'short' }),
            })}
          </p>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-0 overflow-hidden">
        <section
          aria-label={t('portal.translate.source')}
          className="flex min-h-0 flex-col border-r border-line"
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-6 text-xs text-fg2">
            <LocaleTag code={site.defaultLocale} />
            <span className="font-semibold text-fg">{localeName(site.defaultLocale, locale)}</span>
            {t('portal.translate.readOnly')}
            {src ? (
              <span className="ml-auto">
                {formatDate(src.updatedAt, locale, { day: 'numeric', month: 'short' })}
              </span>
            ) : null}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {src ? (
              <>
                <h3 className="m-0 mb-3 text-title font-bold">{src.title}</h3>
                <PortalEditor
                  key={`${src.id}:${src.rev}`}
                  siteId={site.id}
                  value={src.content}
                  editable={false}
                />
              </>
            ) : (
              <Skeleton className="h-40" />
            )}
          </div>
        </section>
        <section aria-label={t('portal.translate.target')} className="flex min-h-0 flex-col">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-6 text-xs text-fg2">
            <LocaleTag code={doc.locale} />
            <span className="font-semibold text-fg">{localeName(doc.locale, locale)}</span>
            <Badge tone={doc.translation === 'outdated' ? 'warn' : 'ok'}>
              {t(
                doc.translation === 'outdated'
                  ? 'portal.translate.outdated'
                  : 'portal.translate.current',
              )}
            </Badge>
            {canEdit && src ? (
              <Button
                size="xs"
                variant="gh"
                className="ml-auto"
                onClick={() => setConfirmCopy(true)}
              >
                <Icon name="copy" size={14} />
                {t('portal.translate.copySource', {
                  language: localeName(site.defaultLocale, locale),
                })}
              </Button>
            ) : null}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <PortalEditor
              key={`${doc.id}:${editorKey}`}
              siteId={site.id}
              value={doc.content}
              editable={canEdit && autosave.state !== 'conflict'}
              onChange={(content) => autosave.queue({ content })}
            />
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={confirmCopy}
        onOpenChange={setConfirmCopy}
        title={t('portal.translate.copyTitle', { language: localeTag(site.defaultLocale) })}
        description={t('portal.translate.copyBody')}
        confirm={t('portal.translate.copyConfirm')}
        onConfirm={async () => {
          if (!src) return;
          autosave.queue({ content: src.content });
          await autosave.flush();
          setEditorKey((k) => k + 1);
        }}
      />
    </div>
  );
}
