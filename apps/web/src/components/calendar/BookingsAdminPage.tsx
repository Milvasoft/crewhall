import { type BookingKind, type BookingResource } from '@crewhall/shared';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Segmented,
  Skeleton,
  Switch,
  Textarea,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader, SettingsRow } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { bookingKeys, resourcesQuery } from '@/lib/calendar/bookings';
import { useFail } from './bits';

/** Yönetim › Oda ve masa (sonraki-isler): the rooms and shared desks people book. */
export function BookingsAdminPage() {
  const { t } = useI18n();
  const q = useQuery(resourcesQuery(undefined, true));
  const [editing, setEditing] = useState<BookingResource | 'new' | null>(null);
  return (
    <Workspace crumbs={[{ label: t('admin.title') }, { label: t('calendar.booking.admin.title') }]}>
      <div className="flex w-full max-w-[760px] flex-col gap-5" data-testid="bookings-admin">
        <PageHeader
          title={t('calendar.booking.admin.title')}
          subtitle={t('calendar.booking.admin.hint')}
          actions={
            <Button size="sm" variant="pri" onClick={() => setEditing('new')}>
              <Icon name="plus" size={16} />
              {t('calendar.booking.admin.add')}
            </Button>
          }
        />
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : !q.data?.items.length ? (
          <EmptyState icon="users" title={t('calendar.booking.empty')} />
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0">
            {q.data.items.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3" aria-label={r.name}>
                <Icon
                  name={r.kind === 'room' ? 'users' : 'laptop'}
                  size={16}
                  className="text-fg2"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">{r.name}</span>
                  <span className="truncate text-xs text-fg2">
                    {[
                      t(`calendar.booking.kind.${r.kind}One`),
                      r.location,
                      r.capacity ? t('calendar.booking.capacity', { count: r.capacity }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {r.checkInRequired ? <Badge>{t('calendar.booking.admin.checkIn')}</Badge> : null}
                {!r.active ? <Badge>{t('calendar.booking.admin.inactive')}</Badge> : null}
                <Tooltip content={t('calendar.booking.admin.edit')}>
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={`${t('calendar.booking.admin.edit')}: ${r.name}`}
                    onClick={() => setEditing(r)}
                  >
                    <Icon name="edit" size={16} />
                  </IconButton>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing ? (
        <ResourceDialog
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Workspace>
  );
}

function ResourceDialog({
  initial,
  onClose,
}: {
  initial: BookingResource | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [kind, setKind] = useState<BookingKind>(initial?.kind ?? 'room');
  const [name, setName] = useState(initial?.name ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [capacity, setCapacity] = useState(initial?.capacity ? String(initial.capacity) : '');
  const [equipment, setEquipment] = useState(initial?.equipment.join(', ') ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [checkIn, setCheckIn] = useState(initial?.checkInRequired ?? false);
  const [grace, setGrace] = useState(String(initial?.checkInGraceMinutes ?? 15));
  const [active, setActive] = useState(initial?.active ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = async (message: string) => {
    toast(message);
    await qc.invalidateQueries({ queryKey: bookingKeys.all });
    onClose();
  };
  const fields = () => ({
    name: name.trim(),
    location: location.trim() || null,
    capacity: kind === 'room' && Number(capacity) > 0 ? Math.round(Number(capacity)) : null,
    equipment: equipment
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
    description: description.trim() || null,
    checkInRequired: checkIn,
    checkInGraceMinutes: Math.min(120, Math.max(5, Math.round(Number(grace) || 15))),
  });
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api.call('updateBookingResource', {
            params: { resourceId: initial.id },
            body: { ...fields(), active },
          })
        : api.call('createBookingResource', { body: { kind, ...fields() } }),
    onSuccess: () => done(t('calendar.booking.admin.saved')),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteBookingResource', { params: { resourceId: initial!.id } }),
    onSuccess: () => done(t('calendar.booking.admin.deleted')),
    onError: fail,
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={520}>
        <DialogHeader
          title={initial ? t('calendar.booking.admin.edit') : t('calendar.booking.admin.add')}
          description={confirmDelete ? t('calendar.booking.admin.deleteBody', { name }) : undefined}
        />
        {confirmDelete ? null : (
          <form
            id="booking-resource"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            {initial ? null : (
              <Segmented
                size="sm"
                className="self-start"
                aria-label={t('calendar.booking.kind.label')}
                value={kind}
                onValueChange={setKind}
                options={[
                  { value: 'room', label: t('calendar.booking.kind.roomOne') },
                  { value: 'desk', label: t('calendar.booking.kind.deskOne') },
                ]}
              />
            )}
            <Field label={t('calendar.booking.admin.name')}>
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field
              label={t('calendar.booking.admin.location')}
              hint={t('calendar.booking.admin.locationHint')}
            >
              <Input
                value={location}
                maxLength={200}
                onChange={(e) => setLocation(e.target.value)}
              />
            </Field>
            {kind === 'room' ? (
              <Field label={t('calendar.booking.admin.capacity')}>
                <Input
                  type="number"
                  min={1}
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                />
              </Field>
            ) : null}
            <Field
              label={t('calendar.booking.admin.equipment')}
              hint={t('calendar.booking.admin.equipmentHint')}
            >
              <Input value={equipment} onChange={(e) => setEquipment(e.target.value)} />
            </Field>
            <Field label={t('calendar.booking.admin.description')}>
              <Textarea
                value={description}
                maxLength={1000}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <SettingsRow
              label={t('calendar.booking.admin.checkIn')}
              description={t('calendar.booking.admin.checkInHint')}
            >
              <Switch
                checked={checkIn}
                onCheckedChange={setCheckIn}
                aria-label={t('calendar.booking.admin.checkIn')}
              />
            </SettingsRow>
            {checkIn ? (
              <Field label={t('calendar.booking.admin.grace')}>
                <Input
                  type="number"
                  min={5}
                  max={120}
                  value={grace}
                  onChange={(e) => setGrace(e.target.value)}
                />
              </Field>
            ) : null}
            {initial ? (
              <SettingsRow label={t('calendar.booking.admin.active')}>
                <Switch
                  checked={active}
                  onCheckedChange={setActive}
                  aria-label={t('calendar.booking.admin.active')}
                />
              </SettingsRow>
            ) : null}
          </form>
        )}
        <DialogFooter>
          {initial && !confirmDelete ? (
            <Button variant="gh" className="mr-auto" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={15} />
              {t('calendar.booking.admin.delete')}
            </Button>
          ) : null}
          <Button variant="gh" onClick={confirmDelete ? () => setConfirmDelete(false) : onClose}>
            {t('common.actions.cancel')}
          </Button>
          {confirmDelete ? (
            <Button variant="dngf" loading={remove.isPending} onClick={() => remove.mutate()}>
              {t('calendar.booking.admin.delete')}
            </Button>
          ) : (
            <Button
              variant="pri"
              type="submit"
              form="booking-resource"
              disabled={!name.trim()}
              loading={save.isPending}
            >
              {t('common.actions.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
