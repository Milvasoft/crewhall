import {
  Button,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal, siteQuery, sitesQuery, versionsQuery } from '@/lib/portal/api';
import { localeName, localeTag } from '@/lib/portal/format';

/**
 * "Portal'a gönder" (design 05 5.12): the page becomes a draft doc of a portal site, or updates
 * the draft it was sent to before (same version and language). Publishing stays in the Portal.
 */
export function PortalSendBody({
  nodeId,
  name,
  onClose,
}: {
  nodeId: string;
  name: string;
  onClose: () => void;
}) {
  const { t, locale: ui } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sites = useQuery(sitesQuery);
  const [siteId, setSiteId] = useState<string | null>(null);
  const chosenId = siteId ?? sites.data?.items[0]?.id ?? '';
  const site = useQuery({ ...siteQuery(chosenId), enabled: Boolean(chosenId) });
  const versions = useQuery({ ...versionsQuery(chosenId), enabled: Boolean(chosenId) });
  const [version, setVersion] = useState<string | null>(null);
  const [lang, setLang] = useState<string | null>(null);

  const summary = sites.data?.items.find((s) => s.id === chosenId);
  const chosenVersion =
    version ?? summary?.currentVersion ?? versions.data?.items[0]?.name ?? undefined;
  const locales = site.data?.locales ?? summary?.locales ?? [];
  const chosenLang = lang ?? (locales.includes(ui) ? ui : (site.data?.defaultLocale ?? locales[0]));

  const send = useMutation({
    mutationFn: () =>
      api.call('createPortalDocFromPage', {
        params: { siteId: chosenId },
        body: { nodeId, version: chosenVersion!, locale: chosenLang! },
      }),
    onSuccess: (res) => {
      invalidatePortal(qc);
      onClose();
      const slug = site.data?.slug ?? summary?.slug;
      toast(
        t(res.created ? 'wiki.portal.created' : 'wiki.portal.updated', { name: res.doc.title }),
        {
          description: res.images.skipped
            ? t('wiki.portal.imagesSkipped', { count: res.images.skipped })
            : undefined,
          action: slug
            ? {
                label: t('wiki.portal.open'),
                onClick: () =>
                  void navigate({
                    to: '/portal/$siteSlug/docs',
                    params: { siteSlug: slug },
                    search: { v: res.doc.version, l: res.doc.locale, doc: res.doc.id },
                  }),
              }
            : undefined,
        },
      );
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const ready = Boolean(chosenId && chosenVersion && chosenLang);
  return (
    <DialogContent width={480}>
      <DialogHeader
        icon="upload"
        title={t('wiki.portal.title')}
        description={t('wiki.portal.hint', { name })}
      />
      {sites.isLoading ? (
        <div className="flex justify-center py-6" role="status">
          <Spinner />
        </div>
      ) : !sites.data?.items.length ? (
        <p className="m-0 flex items-center gap-2 text-sm text-fg2">
          <Icon name="alert" size={16} className="text-warning" />
          {t('wiki.portal.noSites')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {sites.data.items.length > 1 ? (
            <Field label={t('wiki.portal.site')}>
              <Select
                value={chosenId}
                onValueChange={(v) => {
                  setSiteId(v);
                  setVersion(null);
                  setLang(null);
                }}
              >
                <SelectTrigger aria-label={t('wiki.portal.site')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sites.data.items.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('wiki.portal.version')}>
              <Select value={chosenVersion ?? ''} onValueChange={setVersion}>
                <SelectTrigger aria-label={t('wiki.portal.version')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(versions.data?.items ?? []).map((v) => (
                    <SelectItem key={v.id} value={v.name}>
                      {v.label || v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('wiki.portal.language')}>
              <Select value={chosenLang ?? ''} onValueChange={setLang}>
                <SelectTrigger aria-label={t('wiki.portal.language')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((l) => (
                    <SelectItem key={l} value={l}>
                      {`${localeTag(l)} · ${localeName(l, ui)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <p className="m-0 text-cap text-fg3">{t('wiki.portal.note')}</p>
        </div>
      )}
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          disabled={!ready}
          loading={send.isPending}
          onClick={() => send.mutate()}
        >
          {t('wiki.portal.send')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
