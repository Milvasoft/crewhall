import { VAULT_EVENT_ACTIONS, type VaultEvent, type VaultEventAction } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  EmptyState,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useMemo, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { formatTime, formatWeekdayDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { eventsQuery, vaultsQuery } from '@/lib/vault/api';
import { useItemsOf } from '@/lib/vault/items';
import { useHealthCount } from './VaultMain';
import { vaultName, VaultSidebar } from './VaultSidebar';

/** Action names contain dots; i18n keys use underscores (dots mean nesting). */
const actionKey = (a: VaultEventAction) =>
  `vault.log.action.${a.replaceAll('.', '_') as 'item_copy'}` as const;

const RANGES = { '7': 7, '30': 30, '365': 365 } as const;
const DANGER: VaultEventAction[] = [
  'unlock_failed',
  'member.revoke',
  'item.purge',
  'item.revision_purge',
  'vault.delete',
];

/** "Chrome · Windows" from a user agent (design 8.11 "Cihaz"). */
export function deviceOf(ua: string | null): string {
  if (!ua) return '—';
  const app = /crewhall|expo/i.test(ua) ? 'Crewhall' : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return [app ?? browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

/** Access log (design 8.11). Item names are resolved here, from decrypted data. */
export function LogPage({ vaultId }: { vaultId?: string }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const vaults = useQuery(vaultsQuery);
  const list = useMemo(() => vaults.data ?? [], [vaults.data]);
  const healthCount = useHealthCount(list);
  const { items } = useItemsOf(list);
  const [userId, setUserId] = useState<string>('all');
  const [action, setAction] = useState<VaultEventAction | 'all'>('all');
  const [range, setRange] = useState<keyof typeof RANGES>('7');
  const [term, setTerm] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const now = useNow();
  const since = useMemo(
    () => new Date(now - RANGES[range] * 86_400_000).toISOString(),
    [now, range],
  );
  const query = {
    ...(vaultId ? { vaultId } : {}),
    ...(userId !== 'all' ? { userId } : {}),
    ...(action !== 'all' ? { action } : {}),
    since,
    limit: 50,
    ...(cursors.length ? { cursor: cursors[cursors.length - 1] } : {}),
  };
  const events = useQuery(eventsQuery(query));
  const names = useMemo(
    () => new Map(items.map((d) => [d.item.id, d.summary?.name ?? ''])),
    [items],
  );
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events.data?.items ?? []) if (e.actor) m.set(e.actor.id, e.actor.name);
    return [...m];
  }, [events.data]);

  const rows = (events.data?.items ?? []).filter((e) => {
    const q = term.trim().toLocaleLowerCase('tr-TR');
    if (!q) return true;
    return [e.actor?.name, e.itemId ? names.get(e.itemId) : '', e.targetUser?.name].some((v) =>
      v?.toLocaleLowerCase('tr-TR').includes(q),
    );
  });
  const byDay = new Map<string, VaultEvent[]>();
  for (const e of rows) {
    const day = e.at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  const label = (e: VaultEvent) => {
    const base = t(actionKey(e.action));
    if (e.action === 'member.grant' || e.action === 'member.role') {
      return `${base} · ${t(`vault.role.${e.field as 'read'}`)}`;
    }
    if (e.action === 'unlock_failed') {
      return `${base} · ${t('vault.log.attempts', { count: Number(e.meta.attempts ?? 1) })}`;
    }
    if (
      e.field &&
      (e.action === 'item.reveal' || e.action === 'item.copy' || e.action === 'unlock')
    ) {
      return `${base} · ${fieldLabel(e.field)}`;
    }
    return base;
  };
  const fieldLabel = (f: string) => {
    const known = [
      'password',
      'username',
      'totp',
      'key',
      'number',
      'code',
      'private_key',
      'passphrase',
      'passkey_prf',
      'recovery',
      'device',
      'attachment',
    ];
    return known.includes(f) ? t(`vault.log.field.${f as 'password'}`) : f.replace(/^custom:/, '');
  };
  const target = (e: VaultEvent) =>
    e.targetUser?.name ??
    (e.itemId
      ? names.get(e.itemId) || t('vault.log.unknownItem')
      : e.vaultId
        ? vaultName(list.find((v) => v.id === e.vaultId) ?? { kind: 'space', name: '—' }, t)
        : '—');

  const csv = () => {
    const head = ['time', 'person', 'target', 'action', 'device', 'ip'];
    const lines = rows.map((e) =>
      [e.at, e.actor?.email ?? '', target(e), label(e), deviceOf(e.userAgent), e.ip ?? '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const url = URL.createObjectURL(
      new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `crewhall-vault-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Workspace
      sidebar={<VaultSidebar vaults={list} active={vaultId} healthCount={healthCount} />}
      crumbs={[{ label: t('vault.title') }, { label: t('vault.log.title') }]}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          icon="search"
          containerClassName="w-[260px]"
          value={term}
          placeholder={t('vault.log.search')}
          onChange={(e) => setTerm(e.target.value)}
        />
        <Select
          value={vaultId ?? 'all'}
          onValueChange={(v) => {
            setCursors([]);
            void navigate({ to: '/vault/log', search: v === 'all' ? {} : { vaultId: v } });
          }}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('vault.log.allVaults')}</SelectItem>
            {list
              .filter((v) => v.myRole === 'manage')
              .map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {vaultName(v, t)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select
          value={userId}
          onValueChange={(v) => {
            setUserId(v);
            setCursors([]);
          }}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('vault.log.everyone')}</SelectItem>
            {people.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={action}
          onValueChange={(v) => {
            setAction(v as VaultEventAction | 'all');
            setCursors([]);
          }}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('vault.log.allActions')}</SelectItem>
            {VAULT_EVENT_ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {t(actionKey(a))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={range}
          onValueChange={(v) => {
            setRange(v as keyof typeof RANGES);
            setCursors([]);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(RANGES).map((r) => (
              <SelectItem key={r} value={r}>
                {t('vault.log.lastDays', { days: Number(r) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="out" className="ml-auto" onClick={csv} disabled={!rows.length}>
          <Icon name="download" size={15} />
          {t('vault.log.csv')}
        </Button>
      </div>
      {events.isPending ? <Spinner className="mx-auto" /> : null}
      {events.data && !rows.length ? (
        <EmptyState icon="activity" title={t('vault.log.empty')} />
      ) : null}
      {rows.length ? (
        <Table>
          <thead>
            <tr>
              <Th>{t('vault.log.time')}</Th>
              <Th>{t('vault.log.person')}</Th>
              <Th>{t('vault.log.item')}</Th>
              <Th>{t('vault.log.actionCol')}</Th>
              <Th>{t('vault.log.device')}</Th>
              <Th>{t('vault.log.ip')}</Th>
            </tr>
          </thead>
          <tbody>
            {[...byDay].map(([day, list2]) => (
              <Fragment key={day}>
                <tr>
                  <td colSpan={6} className="px-3 pt-4 pb-1 text-xs font-semibold text-fg2">
                    {formatWeekdayDate(new Date(`${day}T12:00:00`), locale)}
                  </td>
                </tr>
                {list2.map((e) => (
                  <Tr key={e.id}>
                    <Td className="text-sm tn">{formatTime(e.at, locale)}</Td>
                    <Td>
                      {e.actor ? (
                        <span className="flex items-center gap-2 text-sm">
                          <Avatar name={e.actor.name} src={e.actor.imageUrl} size="sm" />
                          {e.actor.name}
                        </span>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="text-sm">{target(e)}</Td>
                    <Td className={cn('text-sm', DANGER.includes(e.action) && 'text-danger')}>
                      {label(e)}
                    </Td>
                    <Td className="text-sm text-fg2">{deviceOf(e.userAgent)}</Td>
                    <Td className="font-mono text-xs text-fg2">{e.ip ?? '—'}</Td>
                  </Tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </Table>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-fg3">{t('vault.log.retention')}</span>
        <Button
          size="sm"
          variant="out"
          disabled={!cursors.length}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          {t('vault.log.prev')}
        </Button>
        <Button
          size="sm"
          variant="out"
          disabled={!events.data?.nextCursor}
          onClick={() => setCursors((c) => [...c, events.data!.nextCursor!])}
        >
          {t('vault.log.next')}
        </Button>
      </div>
    </Workspace>
  );
}
