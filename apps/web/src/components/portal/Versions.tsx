import { type PortalVersion } from '@crewhall/shared';
import {
  Badge,
  Button,
  CheckboxRow,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  Switch,
  Table,
  Td,
  Th,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { diffQuery, invalidatePortal, siteQuery, versionsQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { suggestVersion } from '@/lib/portal/format';
import { Card, PageHeader, useWhen } from './common';
import { PortalPage } from './PortalPage';

/** 10.4 versions (Docusaurus model: next, current, archived) and 10.5 freezing a release. */
export function VersionsScreen() {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const search = useSearch({ from: '/_app/portal/$siteSlug/docs/versions' });
  const navigate = useNavigate();
  const versions = useQuery(versionsQuery(site.id));
  const list = versions.data?.items ?? [];
  const current = list.find((v) => v.status === 'current');
  const next = list.find((v) => v.status === 'next');
  const diff = useQuery({
    ...diffQuery(site.id, 'next', current?.name ?? ''),
    enabled: Boolean(next && current),
  });
  const when = useWhen();
  const canPublish = site.capabilities.publish;
  const setFreeze = (v: boolean) =>
    void navigate({
      to: '/portal/$siteSlug/docs/versions',
      params: { siteSlug: site.slug },
      search: v ? { freeze: true } : {},
    });

  const update = useMutation({
    mutationFn: (x: { id: string; showInPicker?: boolean; makeCurrent?: true }) =>
      api.call('updatePortalVersion', {
        params: { versionId: x.id },
        body: { showInPicker: x.showInPicker, makeCurrent: x.makeCurrent },
      }),
    onSuccess: () => invalidatePortal(qc),
    onError: (e) => toast(t(errorKey(e))),
  });

  const nextPublic = useMutation({
    mutationFn: (v: boolean) =>
      api.call('updatePortalSite', {
        params: { siteId: site.id },
        body: { settings: { nextPublic: v } },
      }),
    onSuccess: (s) => qc.setQueryData(siteQuery(site.id).queryKey, s),
    onError: (e) => toast(t(errorKey(e))),
  });

  const counts = (v: PortalVersion) => site.locales.map((l) => v.docCounts[l] ?? 0).join(' / ');

  return (
    <PortalPage crumbs={[{ label: t('portal.nav.docs') }, { label: t('portal.nav.versions') }]}>
      <PageHeader
        title={t('portal.versions.title')}
        subtitle={t('portal.versions.subtitle')}
        actions={
          canPublish && next ? (
            <Button variant="inv" size="sm" onClick={() => setFreeze(true)}>
              <Icon name="lock" size={16} />
              {t('portal.versions.freeze')}
            </Button>
          ) : null
        }
      />
      <div className="overflow-hidden rounded-2xl bg-surface shadow-line">
        <Table aria-label={t('portal.versions.title')}>
          <thead>
            <tr>
              <Th>{t('portal.versions.col.version')}</Th>
              <Th>{t('portal.versions.col.status')}</Th>
              <Th>{t('portal.versions.col.path')}</Th>
              <Th>{site.locales.join(' / ')}</Th>
              <Th>{t('portal.versions.col.editing')}</Th>
              <Th>{t('portal.versions.col.picker')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {versions.isPending ? (
              <tr>
                <Td colSpan={7}>
                  <Skeleton className="h-5" />
                </Td>
              </tr>
            ) : (
              list.map((v) => (
                <tr key={v.id}>
                  <Td>
                    <span className="flex items-center gap-2 font-semibold">
                      {v.label}
                      <Badge
                        tone={
                          v.status === 'current'
                            ? 'accent'
                            : v.status === 'next'
                              ? 'info'
                              : 'default'
                        }
                        plain
                      >
                        {t(`portal.versions.badge.${v.status}`)}
                      </Badge>
                    </span>
                  </Td>
                  <Td className="text-fg2">
                    {v.status === 'next'
                      ? t('portal.versions.nextStatus', { count: v.pendingCount })
                      : t(`portal.versions.statusText.${v.status}`)}
                  </Td>
                  <Td className="font-mono text-xs text-fg2">
                    {v.status === 'next'
                      ? t('portal.versions.nextPath', { name: v.name })
                      : v.status === 'current'
                        ? t('portal.versions.currentPath', { name: v.name })
                        : `/docs/${v.name}/…`}
                  </Td>
                  <Td className="tn">{counts(v)}</Td>
                  <Td className="text-fg2">
                    {v.status === 'archived'
                      ? t('portal.versions.patchOnly', {
                          date: v.frozenAt ? when(v.frozenAt, true) : '',
                        })
                      : t('portal.versions.free')}
                  </Td>
                  <Td>
                    {v.status === 'next' ? (
                      <span className="text-xs text-fg3">{t('portal.versions.previewOnly')}</span>
                    ) : (
                      <Switch
                        aria-label={t('portal.versions.showInPicker', { name: v.label })}
                        checked={v.showInPicker}
                        disabled={!canPublish}
                        onCheckedChange={(c) => update.mutate({ id: v.id, showInPicker: c })}
                      />
                    )}
                  </Td>
                  <Td className="text-right">
                    <span className="flex items-center justify-end gap-1">
                      <Button size="xs" variant="gh" asChild>
                        <Link
                          to="/portal/$siteSlug/docs"
                          params={{ siteSlug: site.slug }}
                          search={{ v: v.name }}
                        >
                          {t('portal.versions.openDocs')}
                        </Link>
                      </Button>
                      {canPublish && v.status === 'archived' ? (
                        <Menu>
                          <MenuTrigger asChild>
                            <IconButton
                              aria-label={t('portal.docs.more')}
                              size="xs"
                              shape="sq"
                              tone="plain"
                            >
                              <Icon name="dots" size={14} />
                            </IconButton>
                          </MenuTrigger>
                          <MenuContent align="end">
                            <MenuItem
                              icon="star"
                              onSelect={() => update.mutate({ id: v.id, makeCurrent: true })}
                            >
                              {t('portal.versions.makeCurrent')}
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      ) : null}
                    </span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card title={t('portal.versions.behaviour')}>
          <div className="flex flex-col">
            <div className="flex items-center gap-3 border-b border-line py-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13.5px] font-semibold">
                  {t('portal.versions.nextPublic')}
                </span>
                <span className="text-xs text-fg2">{t('portal.versions.nextPublicHint')}</span>
              </div>
              <Switch
                aria-label={t('portal.versions.nextPublic')}
                checked={site.settings.nextPublic}
                disabled={!site.capabilities.manage}
                onCheckedChange={(c) => nextPublic.mutate(c)}
              />
            </div>
            <div className="flex flex-col py-3">
              <span className="text-[13.5px] font-semibold">{t('portal.versions.oldBanner')}</span>
              <span className="text-xs text-fg2">{t('portal.versions.oldBannerHint')}</span>
            </div>
          </div>
        </Card>
        {next && current ? (
          <Card title={t('portal.versions.diffTitle', { name: current.name })}>
            {diff.data ? (
              <ul className="flex flex-col gap-2.5 text-[13px]">
                <DiffRow
                  tone="ok"
                  label={t('portal.versions.added', { count: diff.data.added.length })}
                  items={diff.data.added}
                />
                <DiffRow
                  tone="warn"
                  label={t('portal.versions.changed', { count: diff.data.changed.length })}
                  items={diff.data.changed}
                />
                <DiffRow
                  tone="danger"
                  label={t('portal.versions.removed', { count: diff.data.removed.length })}
                  items={diff.data.removed}
                />
                <li className="text-xs text-fg2">
                  {t('portal.versions.diffHint', { name: current.name })}
                </li>
              </ul>
            ) : (
              <Skeleton className="h-16" />
            )}
          </Card>
        ) : null}
      </div>
      {search.freeze && next ? (
        <FreezeDialog versions={list} onClose={() => setFreeze(false)} />
      ) : null}
    </PortalPage>
  );
}

function DiffRow({
  tone,
  label,
  items,
}: {
  tone: 'ok' | 'warn' | 'danger';
  label: string;
  items: { slug: string; title: string }[];
}) {
  return (
    <li className="flex items-start gap-3">
      <Badge tone={tone} className="w-[110px] shrink-0 justify-start">
        {label}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-fg2">
        {items.map((i) => i.title).join(', ') || '-'}
      </span>
    </li>
  );
}

function FreezeDialog({ versions, onClose }: { versions: PortalVersion[]; onClose: () => void }) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const current = versions.find((v) => v.status === 'current');
  const next = versions.find((v) => v.status === 'next');
  const [name, setName] = useState(() => suggestVersion(versions.map((v) => v.name)));
  const [label, setLabel] = useState('');
  const [makeCurrent, setMakeCurrent] = useState(true);
  const [translations, setTranslations] = useState(true);
  const freeze = useMutation({
    mutationFn: () =>
      api.call('freezePortalVersion', {
        params: { siteId: site.id },
        body: {
          name: name.trim(),
          label: label.trim() || null,
          makeCurrent,
          includeTranslations: translations,
        },
      }),
    onSuccess: (v) => {
      invalidatePortal(qc);
      toast(t('portal.versions.frozen', { name: v.name }));
      onClose();
    },
  });
  const source = next?.docCounts[site.defaultLocale] ?? 0;
  const others = site.locales
    .filter((l) => l !== site.defaultLocale)
    .reduce((a, l) => a + (next?.docCounts[l] ?? 0), 0);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent width={520}>
        <DialogHeader
          icon="lock"
          title={t('portal.versions.freeze')}
          description={t('portal.versions.freezeHint')}
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            freeze.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('portal.versions.number')}
              hint={current ? t('portal.versions.last', { current: current.name }) : undefined}
              error={freeze.error ? t(errorKey(freeze.error)) : undefined}
            >
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('portal.versions.label')} hint={t('portal.versions.labelHint')}>
              <Input value={label} placeholder={name} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </div>
          <CheckboxRow checked={makeCurrent} onCheckedChange={(v) => setMakeCurrent(v === true)}>
            <span className="flex flex-col">
              <span className="font-semibold text-fg">{t('portal.versions.makeCurrent')}</span>
              <span className="text-xs">
                {t('portal.versions.makeCurrentHint', { name, current: current?.name ?? '' })}
              </span>
            </span>
          </CheckboxRow>
          {site.locales.length > 1 ? (
            <CheckboxRow
              checked={translations}
              onCheckedChange={(v) => setTranslations(v === true)}
            >
              <span className="flex flex-col">
                <span className="font-semibold text-fg">
                  {t('portal.versions.includeTranslations')}
                </span>
                <span className="text-xs">
                  {t('portal.versions.includeTranslationsHint', { count: others })}
                </span>
              </span>
            </CheckboxRow>
          ) : null}
          <p className="rounded-lg bg-bg2 px-3.5 py-2.5 text-xs text-fg2">
            {t('portal.versions.freezeSummary', {
              count: source,
              n: translations ? others : 0,
            })}
          </p>
          <DialogFooter className="justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-danger">
              <Icon name="alert" size={14} />
              {t('portal.versions.irreversible')}
            </span>
            <span className="flex gap-2">
              <Button variant="gh" size="sm" onClick={onClose}>
                {t('portal.common.cancel')}
              </Button>
              <Button
                type="submit"
                variant="inv"
                size="sm"
                disabled={!name.trim()}
                loading={freeze.isPending}
              >
                {t('portal.versions.freezeConfirm', { name: name.trim() })}
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
