import {
  type Calendar,
  type CalendarSettings,
  type UpdateCalendarSettings,
} from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calDavInfoQuery, calendarKeys } from '@/lib/calendar/queries';
import { hhmm, knownZones } from '@/lib/calendar/time';
import { reminderLabel } from './EventEditor';
import { useFail } from './bits';
import { ConnectedAccounts } from './ConnectedAccounts';

const REMINDERS = [0, 5, 10, 15, 30, 60];

/** Zone, week start, default reminder, working hours, connected accounts, CalDAV, .ics import. */
export function CalendarSettingsDialog({
  settings,
  calendars,
  onClose,
}: {
  settings: CalendarSettings;
  calendars: Calendar[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const zones = useMemo(() => knownZones(), []);
  const [draft, setDraft] = useState<UpdateCalendarSettings>({});
  const value = { ...settings, ...draft };
  const caldav = useQuery(calDavInfoQuery());
  const file = useRef<HTMLInputElement>(null);
  // Connected (Google / Microsoft) calendars take events from their provider only.
  const writable = calendars.filter((c) => c.permissions.write && !c.external);
  const [importTo, setImportTo] = useState(
    writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? '',
  );

  const save = useMutation({
    mutationFn: () => api.call('updateCalendarSettings', { body: draft }),
    onSuccess: async (s) => {
      qc.setQueryData(calendarKeys.settings(), s);
      await qc.invalidateQueries({ queryKey: calendarKeys.all });
      onClose();
    },
    onError: fail,
  });
  const importIcs = useMutation({
    mutationFn: async (f: File) =>
      api.call('importCalendarIcs', {
        params: { calendarId: importTo },
        body: { ics: await f.text() },
      }),
    onSuccess: async (r) => {
      toast(
        t('calendar.settings.imported', { count: r.created, done: r.updated, failed: r.skipped }),
      );
      await qc.invalidateQueries({ queryKey: calendarKeys.all });
    },
    onError: fail,
  });

  const set = (patch: UpdateCalendarSettings) => setDraft((d) => ({ ...d, ...patch }));
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    toast(t('calendar.settings.copied'));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={560}>
        <DialogHeader title={t('calendar.settings.title')} />
        <div className="flex flex-col gap-4">
          <Field label={t('calendar.settings.timeZone')} hint={t('calendar.settings.timeZoneHint')}>
            <Select value={value.timeZone} onValueChange={(v) => set({ timeZone: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('calendar.settings.weekStart')}>
              <Select
                value={String(value.weekStart)}
                onValueChange={(v) => set({ weekStart: Number(v) as 0 | 1 | 6 })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {([1, 0, 6] as const).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {t(`calendar.settings.weekStartDay.${d}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('calendar.settings.defaultReminder')}>
              <Select
                value={String(value.defaultReminders[0] ?? -1)}
                onValueChange={(v) => set({ defaultReminders: v === '-1' ? [] : [Number(v)] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="-1">{t('calendar.settings.noReminder')}</SelectItem>
                  {REMINDERS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {reminderLabel(m, false, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('calendar.settings.workdayStart')}>
              <Select
                value={String(value.workdayStart)}
                onValueChange={(v) => set({ workdayStart: Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hhmm(h * 60)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('calendar.settings.workdayEnd')}>
              <Select
                value={String(value.workdayEnd)}
                onValueChange={(v) => set({ workdayEnd: Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hhmm(h * 60)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <ConnectedAccounts />

          <section
            className="flex flex-col gap-2 rounded-xl bg-bg2 p-4"
            aria-label={t('calendar.settings.caldav')}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Icon name="link" size={15} />
              {t('calendar.settings.caldav')}
            </span>
            <p className="text-xs text-fg2">{t('calendar.settings.caldavHint')}</p>
            {caldav.data ? (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={caldav.data.url}
                    aria-label={t('calendar.settings.caldavUrl')}
                  />
                  <Button size="sm" variant="out" onClick={() => copy(caldav.data.url)}>
                    {t('calendar.settings.copy')}
                  </Button>
                </div>
                <span className="text-xs text-fg3">
                  {t('calendar.settings.caldavUser', { user: caldav.data.username })}
                </span>
                {caldav.data.tokensAvailable ? (
                  <Link
                    to="/account/mcp"
                    className="text-xs font-semibold text-accent-text hover:underline"
                  >
                    {t('calendar.settings.createToken')}
                  </Link>
                ) : (
                  <span className="text-xs text-fg3">{t('calendar.settings.tokensOff')}</span>
                )}
              </>
            ) : null}
          </section>

          <section
            className="flex flex-col gap-2 rounded-xl bg-bg2 p-4"
            aria-label={t('calendar.settings.import')}
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Icon name="upload" size={15} />
              {t('calendar.settings.import')}
            </span>
            <p className="text-xs text-fg2">{t('calendar.settings.importHint')}</p>
            <div className="flex items-center gap-2">
              <Select value={importTo} onValueChange={setImportTo}>
                <SelectTrigger className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {writable.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.isDefault ? t('calendar.sidebar.mine') : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="out"
                loading={importIcs.isPending}
                disabled={!importTo}
                onClick={() => file.current?.click()}
              >
                {t('calendar.settings.chooseFile')}
              </Button>
              <input
                ref={file}
                type="file"
                accept=".ics,text/calendar"
                className="hidden"
                aria-label={t('calendar.settings.chooseFile')}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importIcs.mutate(f);
                  e.target.value = '';
                }}
              />
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="pri" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
