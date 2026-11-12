import { type ScheduledMessage } from '@crewhall/shared';
import {
  Button,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Textarea,
  TimePicker,
  toast,
} from '@crewhall/ui';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { putMessages } from '@/lib/chat/cache';
import { excerptOf, mentionLabel } from '@/lib/chat/names';
import { MENTION_RE } from '@/lib/chat/text';
import { type Conversation } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Scheduled messages ("Daha sonra gönder", `/zamanla`): menu, picker and the waiting list. */

export const scheduledKey = (conversationId: string) =>
  ['chat', 'scheduled', conversationId] as const;

export const scheduledQuery = (conversationId: string) =>
  queryOptions({
    queryKey: scheduledKey(conversationId),
    queryFn: () => api.call('listScheduledMessages', { params: { conversationId } }),
  });

/** Tomorrow at 09:00, local time. */
export function tomorrowAt9(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
}

/** The next Monday at 09:00 (a week ahead when today is Monday). */
export function nextMondayAt9(now = new Date()): Date {
  const ahead = (8 - now.getDay()) % 7 || 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, 9, 0);
}

export function useWhen() {
  const { locale } = useI18n();
  return (at: Date | string) =>
    formatDate(at, locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
}

/** "Daha sonra gönder" next to the send button (also Ctrl/Cmd+Shift+Enter). */
export function ScheduleMenu({
  open,
  onOpenChange,
  onPick,
  onCustom,
  disabled,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (at: Date) => void;
  onCustom: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild disabled={disabled}>
        {children}
      </MenuTrigger>
      <MenuContent align="end" side="top">
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
          {t('chat.schedule.later')}
        </div>
        <MenuItem icon="clock" onSelect={() => onPick(tomorrowAt9())}>
          {t('chat.schedule.tomorrow')}
        </MenuItem>
        <MenuItem icon="clock" onSelect={() => onPick(nextMondayAt9())}>
          {t('chat.schedule.monday')}
        </MenuItem>
        <MenuItem icon="calendar" onSelect={onCustom}>
          {t('chat.schedule.custom')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Date and time (the person's time zone), with the text when editing or from `/zamanla`. */
export function ScheduleDialog({
  title,
  initialAt,
  initialText,
  withText,
  onOpenChange,
  onSubmit,
}: {
  title: string;
  initialAt?: Date;
  initialText?: string;
  withText: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (at: Date, text: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const start = initialAt ?? tomorrowAt9();
  const [day, setDay] = useState(isoDay(start));
  const [time, setTime] = useState(isoTime(start));
  const [text, setText] = useState(initialText ?? '');
  const [busy, setBusy] = useState(false);
  // The dialog's own "now": a time before it opened is in the past.
  const [openedAt] = useState(() => Date.now());
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const at = new Date(y!, (mo ?? 1) - 1, d ?? 1, h ?? 9, mi ?? 0);
  const future = at.getTime() > openedAt;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={420}>
        <DialogHeader title={title} />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!future || busy || (withText && !text.trim())) return;
            setBusy(true);
            void onSubmit(at, text.trim())
              .then((ok) => ok && onOpenChange(false))
              .finally(() => setBusy(false));
          }}
        >
          {withText ? (
            <Field label={t('chat.schedule.text')}>
              <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('chat.schedule.date')}>
              <DatePicker
                value={day}
                min={isoDay(new Date())}
                clearable={false}
                onChange={(v) => v && setDay(v)}
              />
            </Field>
            <Field label={t('chat.schedule.time')}>
              <TimePicker value={time} minuteStep={5} onChange={(v) => v && setTime(v)} />
            </Field>
          </div>
          <p className="m-0 text-xs text-fg3">
            {future ? t('chat.schedule.zone', { zone }) : t('chat.schedule.past')}
          </p>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="pri"
              disabled={!future || busy || (withText && !text.trim())}
            >
              {t('chat.schedule.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mention tokens shown as "@Ad" while editing, and put back on save. */
function withLabels(text: string) {
  const labels = new Map<string, string>();
  const display = text.replace(MENTION_RE, (_, id: string) => {
    const label = mentionLabel(id);
    labels.set(label, `<@${id}>`);
    return label;
  });
  const back = (edited: string) => {
    let out = edited;
    for (const [label, token] of [...labels].sort((a, b) => b[0].length - a[0].length)) {
      out = out.split(label).join(token);
    }
    return out;
  };
  return { display, back };
}

/** "N zamanlanmış mesaj" above the composer, with edit, send now and delete. */
export function ScheduledBar({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const when = useWhen();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const { data } = useQuery(scheduledQuery(conv.id));
  const items = data?.items ?? [];
  if (items.length === 0) return null;

  const refresh = () => void qc.invalidateQueries({ queryKey: scheduledKey(conv.id) });
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      refresh();
      return true;
    } catch (e) {
      toast.error(t(errorKey(e)));
      return false;
    }
  };

  return (
    <div className="mb-1.5 rounded-lg bg-bg2 text-cap">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-semibold"
      >
        <Icon name="clock" size={14} />
        {t('chat.schedule.count', { count: items.length })}
        <Icon name={open ? 'chevD' : 'chevU'} size={14} className="ml-auto text-fg2" />
      </button>
      {open ? (
        <ul className="m-0 flex list-none flex-col p-0 pb-1" aria-label={t('chat.schedule.list')}>
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-2 px-3 py-1">
              <span className="shrink-0 text-xs font-bold text-fg2">{when(s.sendAt)}</span>
              <span className="min-w-0 flex-1 truncate">
                {excerptOf({ text: s.text, card: null }) ||
                  t('chat.schedule.files', { count: s.attachments.length })}
              </span>
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('chat.schedule.edit')}
                onClick={() => setEditing(s)}
              >
                <Icon name="edit" size={13} />
              </IconButton>
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('chat.schedule.sendNow')}
                onClick={() =>
                  void run(async () => {
                    const msg = await api.call('sendScheduledMessageNow', {
                      params: { scheduledId: s.id },
                    });
                    putMessages(qc, conv.id, [msg]);
                  }, t('chat.schedule.sent'))
                }
              >
                <Icon name="send" size={13} />
              </IconButton>
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('chat.schedule.delete')}
                onClick={() =>
                  void run(
                    () => api.call('deleteScheduledMessage', { params: { scheduledId: s.id } }),
                    t('chat.schedule.deleted'),
                  )
                }
              >
                <Icon name="trash" size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <ScheduleDialog
          title={t('chat.schedule.editTitle')}
          initialAt={new Date(editing.sendAt)}
          initialText={withLabels(editing.text).display}
          withText={editing.attachments.length === 0}
          onOpenChange={(v) => !v && setEditing(null)}
          onSubmit={(at, text) =>
            run(
              () =>
                api.call('updateScheduledMessage', {
                  params: { scheduledId: editing.id },
                  body: {
                    sendAt: at.toISOString(),
                    ...(editing.attachments.length === 0
                      ? { text: withLabels(editing.text).back(text) }
                      : {}),
                  },
                }),
              t('chat.schedule.saved'),
            )
          }
        />
      ) : null}
    </div>
  );
}
