import {
  localize,
  type LocalizedText,
  type PluginBrowserCapability,
  type PluginPermission,
  type RiskLevel,
} from '@crewhall/plugin-sdk';
import { type PluginCatalogItem, type PluginInstallation } from '@crewhall/shared';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  Input,
  Skeleton,
  Switch,
  Tag,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useDeferredValue, useState } from 'react';
import { PageHeader, SettingsCard } from '@/components/admin/Settings';
import { Notice } from '@/components/auth/AuthLayout';
import { ConfirmDialog, useConfirm } from '@/components/mcp/parts';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { pluginCatalogQuery, pluginInstallationsQuery, pluginKeys } from '@/lib/plugins/queries';

export const Route = createFileRoute('/_app/admin/plugins')({
  component: PluginsPage,
});

type T = ReturnType<typeof useI18n>['t'];

const RISK_TONE: Record<RiskLevel, 'ok' | 'info' | 'warn'> = {
  official: 'ok',
  verified: 'info',
  unofficial: 'warn',
};

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const { t } = useI18n();
  return (
    <Badge tone={RISK_TONE[risk]} title={t(`plugins.riskHint.${risk}`)}>
      {t(`plugins.risk.${risk}`)}
    </Badge>
  );
}

function PluginIcon({ src }: { src: string | null }) {
  return src ? (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className="size-10 shrink-0 rounded-lg bg-bg2"
    />
  ) : (
    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-bg2 text-fg2">
      <Icon name="plug" size={18} />
    </span>
  );
}

const scopeLabel = (t: T, p: string) => t(`mcp.scopes.${p}` as Parameters<T>[0]);

/** Granted permissions; the ones asked for and not granted follow, struck through. */
function Permissions({
  list,
  withheld = [],
  label,
}: {
  list: string[];
  withheld?: string[];
  label?: (p: string) => string;
}) {
  const { t } = useI18n();
  const name = label ?? ((p: string) => scopeLabel(t, p));
  if (list.length === 0 && withheld.length === 0) {
    return <span className="text-cap text-fg2">{t('plugins.admin.noPermissions')}</span>;
  }
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {list.map((p) => (
        <li key={p}>
          <Tag>{name(p)}</Tag>
        </li>
      ))}
      {withheld.map((p) => (
        <li key={p} title={t('plugins.admin.withheld')}>
          <Tag className="text-fg3 line-through">{name(p)}</Tag>
        </li>
      ))}
    </ul>
  );
}

/** One checkbox per permission (or browser feature) asked for; unticked ones are not granted. */
function PermissionPicker<P extends string>({
  asked,
  granted,
  onChange,
  label,
}: {
  asked: P[];
  granted: P[];
  onChange: (next: P[]) => void;
  label?: (p: P) => string;
}) {
  const { t } = useI18n();
  if (asked.length === 0) {
    return <span className="text-cap text-fg2">{t('plugins.admin.noPermissions')}</span>;
  }
  return (
    <div className="flex flex-col rounded-xl px-3 shadow-line">
      {asked.map((p) => (
        <label
          key={p}
          className="flex h-10 cursor-pointer items-center gap-3 border-b border-line text-sm last:border-b-0"
        >
          <Checkbox
            checked={granted.includes(p)}
            onCheckedChange={(v) =>
              onChange(v === true ? [...granted, p] : granted.filter((x) => x !== p))
            }
          />
          <span className="flex-1">{label ? label(p) : scopeLabel(t, p)}</span>
          <span className="font-mono text-xs text-fg3">{p}</span>
        </label>
      ))}
    </div>
  );
}

/** What a dialog with permission checkboxes is about: install, an update, or the grant. */
type Consent =
  | { kind: 'install'; item: PluginCatalogItem }
  | { kind: 'upgrade'; inst: PluginInstallation }
  | { kind: 'edit'; inst: PluginInstallation };

/**
 * Yönetim › Eklentiler (docs/contracts/eklentiler.md › Kurulum): what is installed, the central
 * marketplace's catalog, install with the permissions approved, updates that ask again when
 * they want more, turn off and remove.
 */
function PluginsPage() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const installed = useQuery(pluginInstallationsQuery);
  const catalog = useQuery(pluginCatalogQuery(query));
  const [consent, setConsent] = useState<Consent | null>(null);
  const [grant, setGrant] = useState<PluginPermission[]>([]);
  /** Browser features (API 32): the same consent, delegated to the frames. */
  const [browserGrant, setBrowserGrant] = useState<PluginBrowserCapability[]>([]);
  const browserLabel = (c: PluginBrowserCapability) => t(`plugins.browser.${c}`);
  /** Self-hosted plugins: the org's own server, typed in the install dialog. */
  const [selfOrigin, setSelfOrigin] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [ref, setRef] = useState('');
  const removing = useConfirm<PluginInstallation>();
  const name = (text: LocalizedText) => localize(text, locale);
  const installing = consent?.kind === 'install' ? consent.item : null;

  const ask = (c: Consent) => {
    setConsent(c);
    setSelfOrigin('');
    setGrant(
      c.kind === 'install'
        ? c.item.permissions
        : c.kind === 'upgrade'
          ? (c.inst.update?.addedPermissions ?? [])
          : c.inst.permissions,
    );
    setBrowserGrant(
      c.kind === 'install'
        ? c.item.browser
        : c.kind === 'upgrade'
          ? (c.inst.update?.addedBrowser ?? [])
          : (c.inst.browser ?? []),
    );
  };
  const close = () => setConsent(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: pluginKeys.all });
  const fail = (e: unknown) => toast.error(t(errorKey(e)));

  const install = useMutation({
    mutationFn: (v: {
      item: PluginCatalogItem;
      permissions: PluginPermission[];
      browser: PluginBrowserCapability[];
    }) =>
      api.call('installPlugin', {
        body: {
          pluginId: v.item.id,
          version: v.item.version,
          permissions: v.permissions,
          browser: v.browser,
          ...(v.item.hosting === 'self' ? { selfOrigin: selfOrigin.trim() } : {}),
        },
      }),
    onSuccess: (inst) => {
      close();
      refresh();
      toast(t('plugins.admin.installedToast', { name: name(inst.name) }));
    },
    onError: fail,
  });
  // "ID ya da bağlantıyla kur": unlisted plugins are found only this way.
  const lookup = useMutation({
    mutationFn: (value: string) => api.call('lookupPlugin', { query: { ref: value.trim() } }),
    onSuccess: (item) => {
      setLookingUp(false);
      setRef('');
      if (item.installationId) {
        toast(t('plugins.admin.alreadyInstalled', { name: name(item.name) }));
      } else {
        ask({ kind: 'install', item });
      }
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api.call('updatePluginInstallation', {
        params: { installationId: v.id },
        body: { enabled: v.enabled },
      }),
    onSuccess: refresh,
    onError: fail,
  });
  const regrant = useMutation({
    mutationFn: (v: {
      inst: PluginInstallation;
      permissions: PluginPermission[];
      browser: PluginBrowserCapability[];
    }) =>
      api.call('updatePluginInstallation', {
        params: { installationId: v.inst.id },
        body: { permissions: v.permissions, browser: v.browser },
      }),
    onSuccess: (inst) => {
      close();
      refresh();
      toast(t('plugins.admin.permissionsSaved', { name: name(inst.name) }));
    },
    onError: fail,
  });
  const upgrade = useMutation({
    mutationFn: (v: {
      inst: PluginInstallation;
      accept: PluginPermission[];
      acceptBrowser: PluginBrowserCapability[];
    }) =>
      api.call('upgradePlugin', {
        params: { installationId: v.inst.id },
        body: {
          version: v.inst.update!.version,
          acceptPermissions: v.accept,
          acceptBrowser: v.acceptBrowser,
        },
      }),
    onSuccess: (inst) => {
      close();
      refresh();
      toast(t('plugins.admin.updated', { name: name(inst.name) }));
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (inst: PluginInstallation) =>
      api.call('uninstallPlugin', { params: { installationId: inst.id } }),
    onSuccess: (_, inst) => {
      removing.close();
      refresh();
      toast(t('plugins.admin.removed', { name: name(inst.name) }));
    },
    onError: fail,
  });

  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('plugins.nav') }]}>
      <PageHeader title={t('plugins.admin.title')} subtitle={t('plugins.admin.subtitle')} />
      <div className="flex flex-col gap-5">
        <SettingsCard title={t('plugins.admin.installed')}>
          {!installed.data ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : installed.data.length === 0 ? (
            <p className="m-0 text-cap text-fg2">{t('plugins.admin.noneInstalled')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {installed.data.map((inst) => (
                <li
                  key={inst.id}
                  className="flex flex-wrap items-start gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0"
                >
                  <PluginIcon src={inst.icon} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-cap font-semibold">{name(inst.name)}</span>
                      <RiskBadge risk={inst.risk} />
                      {inst.hosting === 'self' ? (
                        <Badge tone="info" title={inst.selfOrigin ?? undefined}>
                          {t('plugins.admin.selfHosted')}
                        </Badge>
                      ) : null}
                    </span>
                    {inst.selfOrigin ? (
                      <span className="text-xs text-fg2">
                        {t('plugins.admin.selfOriginAt', { origin: inst.selfOrigin })}
                      </span>
                    ) : null}
                    <span className="text-xs text-fg2">
                      {t('plugins.admin.publisher', {
                        name: inst.publisher.name,
                        version: inst.version,
                      })}
                      {inst.installedBy
                        ? ` · ${t('plugins.admin.installedBy', {
                            name: inst.installedBy.name,
                            date: formatDateLong(inst.installedAt, locale),
                          })}`
                        : ''}
                    </span>
                    <Permissions
                      list={inst.permissions}
                      withheld={(inst.requestedPermissions ?? []).filter(
                        (p) => !inst.permissions.includes(p),
                      )}
                    />
                    {inst.requestedBrowser?.length ? (
                      <Permissions
                        list={inst.browser ?? []}
                        withheld={inst.requestedBrowser.filter(
                          (c) => !(inst.browser ?? []).includes(c),
                        )}
                        label={(c) => browserLabel(c as PluginBrowserCapability)}
                      />
                    ) : null}
                    {inst.update ? (
                      <Button
                        size="sm"
                        variant="out"
                        className="self-start"
                        loading={upgrade.isPending && upgrade.variables?.inst.id === inst.id}
                        onClick={() =>
                          inst.update!.addedPermissions.length || inst.update!.addedBrowser?.length
                            ? ask({ kind: 'upgrade', inst })
                            : upgrade.mutate({ inst, accept: [], acceptBrowser: [] })
                        }
                      >
                        <Icon name="download" size={14} />
                        {t('plugins.admin.update', { version: inst.update.version })}
                      </Button>
                    ) : null}
                  </div>
                  <span className="flex items-center gap-2">
                    {(inst.requestedPermissions ?? inst.permissions).length ||
                    inst.requestedBrowser?.length ? (
                      <Button size="sm" variant="gh" onClick={() => ask({ kind: 'edit', inst })}>
                        {t('plugins.admin.editPermissions')}
                      </Button>
                    ) : null}
                    <Switch
                      aria-label={t('plugins.admin.toggle', { name: name(inst.name) })}
                      checked={inst.status === 'active'}
                      disabled={toggle.isPending}
                      onCheckedChange={(enabled) => toggle.mutate({ id: inst.id, enabled })}
                    />
                    <Button size="sm" variant="dng" onClick={() => removing.ask(inst)}>
                      {t('plugins.admin.uninstall')}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>

        <SettingsCard
          title={t('plugins.admin.catalog')}
          aside={
            <span className="flex flex-wrap items-center gap-2">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('plugins.admin.search')}
                aria-label={t('plugins.admin.search')}
                className="h-9 w-[220px]"
              />
              <Button size="sm" variant="out" onClick={() => setLookingUp(true)}>
                <Icon name="link" size={14} />
                {t('plugins.admin.byRef')}
              </Button>
            </span>
          }
        >
          {catalog.isError ? (
            <Notice tone="error">{t('plugins.admin.catalogError')}</Notice>
          ) : !catalog.data ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : catalog.data.length === 0 ? (
            <EmptyState icon="search" title={t('plugins.admin.empty')} />
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
              {catalog.data.map((item) => (
                <li key={item.id} className="flex gap-3 rounded-xl p-3 shadow-line">
                  <PluginIcon src={item.icon} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-cap font-semibold">{name(item.name)}</span>
                      <RiskBadge risk={item.risk} />
                      {item.hosting === 'self' ? (
                        <Badge tone="info">{t('plugins.admin.selfHosted')}</Badge>
                      ) : null}
                    </span>
                    <span className="text-xs text-fg2">
                      {t('plugins.admin.publisher', {
                        name: item.publisher.name,
                        version: item.version,
                      })}
                    </span>
                    <p className="m-0 line-clamp-2 text-cap text-fg2">{name(item.description)}</p>
                  </div>
                  {item.installationId ? (
                    <Badge tone="ok" className="self-start">
                      {t('plugins.admin.active')}
                    </Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="out"
                      className="self-start"
                      onClick={() => ask({ kind: 'install', item })}
                    >
                      {t('plugins.admin.install')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      </div>

      <Dialog open={installing !== null} onOpenChange={(o) => !o && close()}>
        {installing ? (
          <DialogContent width={520}>
            <DialogHeader
              icon="plug"
              title={t('plugins.admin.installTitle', { name: name(installing.name) })}
              description={
                installing.hosting === 'self'
                  ? t('plugins.admin.installHintSelf')
                  : t('plugins.admin.installHint', { origin: installing.origin })
              }
            />
            <div className="flex flex-col gap-3">
              {installing.hosting === 'self' ? (
                <Field
                  label={t('plugins.admin.selfOrigin')}
                  hint={t('plugins.admin.selfOriginHint')}
                >
                  <Input
                    value={selfOrigin}
                    onChange={(e) => setSelfOrigin(e.target.value)}
                    placeholder="https://wa.kurum.com"
                    inputMode="url"
                    autoComplete="off"
                  />
                </Field>
              ) : null}
              <span className="flex items-center gap-2">
                <RiskBadge risk={installing.risk} />
                <span className="text-xs text-fg2">{t(`plugins.riskHint.${installing.risk}`)}</span>
              </span>
              {installing.riskNote ? (
                <Notice tone="error">{name(installing.riskNote)}</Notice>
              ) : null}
              <span className="eyebrow">{t('plugins.admin.permissions')}</span>
              <PermissionPicker
                asked={installing.permissions}
                granted={grant}
                onChange={setGrant}
              />
              {grant.length < installing.permissions.length ? (
                <span className="text-xs text-fg2">{t('plugins.admin.partialHint')}</span>
              ) : null}
              {installing.browser.length ? (
                <>
                  <span className="eyebrow">{t('plugins.admin.browser')}</span>
                  <span className="text-xs text-fg2">{t('plugins.admin.browserHint')}</span>
                  <PermissionPicker
                    asked={installing.browser}
                    granted={browserGrant}
                    onChange={setBrowserGrant}
                    label={browserLabel}
                  />
                </>
              ) : null}
              <span className="eyebrow">{t('plugins.admin.entry')}</span>
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {(['tabs', 'cards', 'commands', 'tools', 'events'] as const)
                  .filter((k) => installing.entryPoints[k] > 0)
                  .map((k) => (
                    <li key={k}>
                      <Tag>
                        {t(`plugins.admin.entryPoints.${k}`, { count: installing.entryPoints[k] })}
                      </Tag>
                    </li>
                  ))}
              </ul>
            </div>
            <DialogFooter>
              <Button variant="gh" onClick={close}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="pri"
                loading={install.isPending}
                disabled={installing.hosting === 'self' && !selfOrigin.trim()}
                onClick={() =>
                  install.mutate({ item: installing, permissions: grant, browser: browserGrant })
                }
              >
                {grant.length < installing.permissions.length
                  ? t('plugins.admin.approvePartial')
                  : t('plugins.admin.approve')}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={consent !== null && consent.kind !== 'install'}
        onOpenChange={(o) => !o && close()}
      >
        {consent && consent.kind !== 'install' ? (
          <DialogContent width={480}>
            <DialogHeader
              icon={consent.kind === 'upgrade' ? 'download' : 'plug'}
              title={
                consent.kind === 'upgrade'
                  ? t('plugins.admin.update', { version: consent.inst.update?.version ?? '' })
                  : t('plugins.admin.permissionsTitle', { name: name(consent.inst.name) })
              }
              description={
                consent.kind === 'upgrade'
                  ? t('plugins.admin.updateNeeds')
                  : t('plugins.admin.permissionsHint')
              }
            />
            {(() => {
              const asked =
                consent.kind === 'upgrade'
                  ? (consent.inst.update?.addedPermissions ?? [])
                  : (consent.inst.requestedPermissions ?? consent.inst.permissions);
              const askedBrowser =
                consent.kind === 'upgrade'
                  ? (consent.inst.update?.addedBrowser ?? [])
                  : (consent.inst.requestedBrowser ?? []);
              return (
                <div className="flex flex-col gap-3">
                  {asked.length || !askedBrowser.length ? (
                    <PermissionPicker asked={asked} granted={grant} onChange={setGrant} />
                  ) : null}
                  {askedBrowser.length ? (
                    <>
                      <span className="eyebrow">{t('plugins.admin.browser')}</span>
                      <PermissionPicker
                        asked={askedBrowser}
                        granted={browserGrant}
                        onChange={setBrowserGrant}
                        label={browserLabel}
                      />
                    </>
                  ) : null}
                </div>
              );
            })()}
            <DialogFooter>
              <Button variant="gh" onClick={close}>
                {t('common.actions.cancel')}
              </Button>
              {consent.kind === 'upgrade' ? (
                <Button
                  variant="pri"
                  loading={upgrade.isPending}
                  onClick={() =>
                    upgrade.mutate({
                      inst: consent.inst,
                      accept: grant,
                      acceptBrowser: browserGrant,
                    })
                  }
                >
                  {t('plugins.admin.updateApprove')}
                </Button>
              ) : (
                <Button
                  variant="pri"
                  loading={regrant.isPending}
                  onClick={() =>
                    regrant.mutate({
                      inst: consent.inst,
                      permissions: grant,
                      browser: browserGrant,
                    })
                  }
                >
                  {t('common.actions.save')}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog open={lookingUp} onOpenChange={setLookingUp}>
        <DialogContent width={460}>
          <DialogHeader
            icon="link"
            title={t('plugins.admin.byRefTitle')}
            description={t('plugins.admin.byRefHint')}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (ref.trim()) lookup.mutate(ref);
            }}
          >
            <Field label={t('plugins.admin.byRefLabel')}>
              <Input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="com.acme.tool"
                autoComplete="off"
                autoFocus
              />
            </Field>
            <DialogFooter>
              <Button variant="gh" type="button" onClick={() => setLookingUp(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button variant="pri" type="submit" loading={lookup.isPending} disabled={!ref.trim()}>
                {t('plugins.admin.byRefFind')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing.target !== null}
        onOpenChange={(o) => !o && removing.close()}
        title={t('plugins.admin.uninstall')}
        body={t('plugins.admin.uninstallConfirm', {
          name: removing.target ? name(removing.target.name) : '',
        })}
        confirm={t('plugins.admin.uninstall')}
        pending={remove.isPending}
        onConfirm={() => removing.target && remove.mutate(removing.target)}
      />
    </Workspace>
  );
}
