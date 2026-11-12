import { type Calendar, type SpaceColor, type UserSummary } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, idempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarKeys, calendarMembersQuery } from '@/lib/calendar/queries';
import { useMe } from '@/lib/session';
import { AttendeePicker } from './AttendeePicker';
import { COLORS, DOT, useFail } from './bits';

type Role = 'editor' | 'viewer';

/** New team calendar, or rename/recolour/members of one the caller owns. */
export function CalendarDialog({
  calendar,
  onClose,
}: {
  calendar?: Calendar;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const me = useMe();
  const [name, setName] = useState(calendar?.name ?? '');
  const [color, setColor] = useState<SpaceColor>(calendar?.color ?? 's2');
  const [description, setDescription] = useState(calendar?.description ?? '');
  const [people, setPeople] = useState<UserSummary[]>([]);
  const isTeam = !calendar || calendar.kind === 'team';
  const members = useQuery({
    ...calendarMembersQuery(calendar?.id ?? ''),
    enabled: Boolean(calendar && calendar.kind === 'team'),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: calendarKeys.all });
  const create = useMutation({
    mutationFn: () =>
      api.call('createCalendar', {
        body: {
          name: name.trim(),
          color,
          description: description.trim() || undefined,
          members: people.map((p) => ({ userId: p.id, role: 'editor' as const })),
        },
        idempotencyKey: idempotencyKey(),
      }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: () =>
      api.call('updateCalendar', {
        params: { calendarId: calendar!.id },
        body: { name: name.trim(), color, description: description.trim() || null },
      }),
    onSuccess: async () => {
      for (const p of people) {
        await api.call('setCalendarMember', {
          params: { calendarId: calendar!.id, userId: p.id },
          body: { role: 'editor' },
        });
      }
      await refresh();
      onClose();
    },
    onError: fail,
  });
  const setRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: Role | 'remove' }) => {
      if (role === 'remove') {
        await api.call('removeCalendarMember', { params: { calendarId: calendar!.id, userId } });
      } else {
        await api.call('setCalendarMember', {
          params: { calendarId: calendar!.id, userId },
          body: { role },
        });
      }
    },
    onSuccess: () => refresh(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteCalendar', { params: { calendarId: calendar!.id } }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: fail,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (calendar) update.mutate();
    else create.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={520}>
        <DialogHeader
          title={calendar ? t('calendar.dialog.editTitle') : t('calendar.dialog.newTitle')}
          description={calendar ? undefined : t('calendar.dialog.newHint')}
        />
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t('calendar.dialog.name')}>
            <Input
              autoFocus
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t('calendar.dialog.color')}>
            <div className="flex gap-2" role="radiogroup" aria-label={t('calendar.dialog.color')}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={c}
                  onClick={() => setColor(c)}
                  className={cn(
                    'size-7 rounded-full',
                    DOT[c],
                    color === c && 'ring-2 ring-fg ring-offset-2 ring-offset-surface',
                  )}
                />
              ))}
            </div>
          </Field>
          <Field label={t('calendar.dialog.description')}>
            <Input
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {isTeam ? (
            <Field label={t('calendar.dialog.members')} hint={t('calendar.dialog.membersHint')}>
              <AttendeePicker
                people={people}
                onPeople={setPeople}
                emails={[]}
                onEmails={() => undefined}
              />
            </Field>
          ) : null}
          {members.data?.items.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {members.data.items.map((m) => (
                <li key={m.user.id} className="flex items-center gap-2 text-sm">
                  <Avatar name={m.user.name} src={m.user.imageUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{m.user.name}</span>
                  {m.role === 'owner' ? (
                    <span className="text-xs text-fg3">{t('calendar.role.owner')}</span>
                  ) : (
                    <>
                      <Select
                        value={m.role}
                        onValueChange={(v) =>
                          setRole.mutate({ userId: m.user.id, role: v as Role })
                        }
                      >
                        <SelectTrigger className="h-8 w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="editor">{t('calendar.role.editor')}</SelectItem>
                          <SelectItem value="viewer">{t('calendar.role.viewer')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <IconButton
                        size="xs"
                        tone="plain"
                        aria-label={t('calendar.editor.remove', { name: m.user.name })}
                        onClick={() => setRole.mutate({ userId: m.user.id, role: 'remove' })}
                        disabled={m.user.id === me?.user.id}
                      >
                        <Icon name="x" size={13} />
                      </IconButton>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            {calendar?.kind === 'team' ? (
              <Button
                variant="dng"
                className="mr-auto"
                onClick={() => remove.mutate()}
                loading={remove.isPending}
              >
                {t('calendar.dialog.delete')}
              </Button>
            ) : null}
            <Button variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="pri"
              loading={create.isPending || update.isPending}
              disabled={!name.trim()}
            >
              {calendar ? t('common.actions.save') : t('calendar.dialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
