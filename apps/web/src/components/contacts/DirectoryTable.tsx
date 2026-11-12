import { type DirectoryField, type OrgChart, type OrgChartNode } from '@crewhall/shared';
import {
  Avatar,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  Td,
  Th,
  toast,
  Tooltip,
  Tr,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { contactsKeys } from '@/lib/contacts/queries';
import { descendantsOf } from '@/lib/contacts/chart';

type TextField = 'title' | 'department' | 'team';

const NONE = '__none__';

/**
 * The org chart as a table (sonraki-isler): person | title | department | team | manager.
 * Admins edit in place (a field saves when it loses focus); fields synced from the directory
 * stay locked. Everyone else reads it.
 */
export function DirectoryTable({
  items,
  q,
  admin,
  onSelect,
}: {
  items: OrgChartNode[];
  q: string;
  admin: boolean;
  onSelect: (userId: string) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: {
      userId: string;
      body: Partial<Record<TextField, string | null>> & { managerId?: string | null };
    }) => api.call('updateDirectoryProfile', { params: { userId: v.userId }, body: v.body }),
    onMutate: async (v) => {
      const key = contactsKeys.chart();
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<OrgChart>(key, (d) =>
        d
          ? {
              ...d,
              items: d.items.map((n) => (n.user.id === v.userId ? { ...n, ...v.body } : n)),
            }
          : d,
      );
    },
    onSuccess: () => toast(t('contacts.chart.table.saved')),
    onError: (e) => toast(t(errorKey(e))),
    onSettled: () => qc.invalidateQueries({ queryKey: contactsKeys.all }),
  });

  const term = q.trim().toLocaleLowerCase('tr');
  const rows = useMemo(
    () =>
      [...items]
        .filter(
          (n) =>
            !term ||
            `${n.user.name} ${n.title ?? ''} ${n.department ?? ''} ${n.team ?? ''}`
              .toLocaleLowerCase('tr')
              .includes(term),
        )
        .sort((a, b) => a.user.name.localeCompare(b.user.name, 'tr')),
    [items, term],
  );
  const people = useMemo(
    () => [...items].sort((a, b) => a.user.name.localeCompare(b.user.name, 'tr')),
    [items],
  );
  const name = (id: string | null) =>
    id ? (items.find((n) => n.user.id === id)?.user.name ?? '') : '';
  const locked = (n: OrgChartNode, f: DirectoryField) => (n.syncedFields ?? []).includes(f);

  return (
    <div className="min-h-0 overflow-auto rounded-xl border border-line">
      <Table className="min-w-[760px]" aria-label={t('contacts.chart.table.caption')}>
        <thead>
          <Tr>
            <Th>{t('contacts.chart.table.person')}</Th>
            <Th>{t('contacts.fields.title')}</Th>
            <Th>{t('contacts.fields.department')}</Th>
            <Th>{t('contacts.fields.team')}</Th>
            <Th>{t('contacts.fields.manager')}</Th>
          </Tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <Tr key={n.user.id}>
              <Td>
                <button
                  type="button"
                  onClick={() => onSelect(n.user.id)}
                  className="flex min-w-0 items-center gap-2 text-left font-semibold hover:underline"
                >
                  <Avatar name={n.user.name} src={n.user.imageUrl} size="sm" />
                  <span className="truncate">{n.user.name}</span>
                </button>
              </Td>
              {(['title', 'department', 'team'] as const).map((f) => (
                <Td key={f}>
                  {admin && !locked(n, f) ? (
                    <CellInput
                      label={`${n.user.name} · ${t(`contacts.fields.${f}`)}`}
                      value={(f === 'team' ? n.team : n[f]) ?? ''}
                      onSave={(v) => save.mutate({ userId: n.user.id, body: { [f]: v || null } })}
                    />
                  ) : (
                    <Tooltip content={locked(n, f) ? t('contacts.directory.synced') : undefined}>
                      <span className="block truncate text-sm text-fg2">
                        {(f === 'team' ? n.team : n[f]) ?? '—'}
                      </span>
                    </Tooltip>
                  )}
                </Td>
              ))}
              <Td>
                {admin && !n.managerSynced ? (
                  <ManagerSelect
                    n={n}
                    people={people}
                    items={items}
                    onPick={(managerId) => save.mutate({ userId: n.user.id, body: { managerId } })}
                  />
                ) : (
                  <span className="block truncate text-sm text-fg2">
                    {name(n.managerId) || t('contacts.chart.table.noManager')}
                  </span>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function CellInput({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // The saved value changed under the input (another edit, a refetch): follow it.
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    const v = draft.trim();
    if (v !== value) onSave(v);
  };
  return (
    <Input
      aria-label={label}
      value={draft}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
      className="h-8"
    />
  );
}

function ManagerSelect({
  n,
  people,
  items,
  onPick,
}: {
  n: OrgChartNode;
  people: OrgChartNode[];
  items: OrgChartNode[];
  onPick: (managerId: string | null) => void;
}) {
  const { t } = useI18n();
  // Not themselves, not anyone under them.
  const blocked = useMemo(() => descendantsOf(items, n.user.id), [items, n.user.id]);
  return (
    <Select value={n.managerId ?? NONE} onValueChange={(v) => onPick(v === NONE ? null : v)}>
      <SelectTrigger
        className="h-8 min-w-[180px]"
        aria-label={`${n.user.name} · ${t('contacts.fields.manager')}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('contacts.chart.table.noManager')}</SelectItem>
        {people
          .filter((p) => !blocked.has(p.user.id))
          .map((p) => (
            <SelectItem key={p.user.id} value={p.user.id}>
              {p.user.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
