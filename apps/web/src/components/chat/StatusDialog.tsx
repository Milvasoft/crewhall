import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { chatKeys, myStatusQuery } from '@/lib/chat/queries';
import { setPresence } from '@/lib/chat/stores';
import { type StatusVisibility, type UserStatus } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { openStatusDialog, useStatusDialogOpen } from './dialogs';
import { EmojiPicker } from './EmojiPicker';

type Clear = 'never' | '30m' | '1h' | '4h' | 'today' | 'week';
const CLEARS: Clear[] = ['30m', '1h', '4h', 'today', 'week', 'never'];

export function clearAt(c: Clear, now = new Date()): string | null {
  const d = new Date(now);
  if (c === 'never') return null;
  if (c === '30m') return new Date(d.getTime() + 30 * 60_000).toISOString();
  if (c === '1h') return new Date(d.getTime() + 3_600_000).toISOString();
  if (c === '4h') return new Date(d.getTime() + 4 * 3_600_000).toISOString();
  if (c === 'today') {
    d.setHours(23, 59, 0, 0);
    return d.toISOString();
  }
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

const SUGGESTIONS: { key: 'meeting' | 'focus' | 'home' | 'leave'; emoji: string; clear: Clear }[] =
  [
    { key: 'meeting', emoji: '📅', clear: '1h' },
    { key: 'focus', emoji: '🎯', clear: '4h' },
    { key: 'home', emoji: '🏠', clear: 'today' },
    { key: 'leave', emoji: '🌴', clear: 'week' },
  ];

const VISIBILITY: StatusVisibility[] = ['online', 'busy', 'dnd', 'away', 'invisible'];

/** Mounted once by the chat runtime; Alt S opens it anywhere. */
export function StatusDialog() {
  const open = useStatusDialogOpen();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        openStatusDialog(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <Dialog open={open} onOpenChange={openStatusDialog}>
      {open ? <Body /> : null}
    </Dialog>
  );
}

function Body() {
  const { t } = useI18n();
  const { data } = useQuery(myStatusQuery);
  return (
    <DialogContent width={520}>
      <DialogHeader title={t('chat.status.title')} />
      {data ? <Form initial={data} /> : <Skeleton className="h-64 w-full" />}
    </DialogContent>
  );
}

function Form({ initial }: { initial: UserStatus }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const me = useMe()?.user.id ?? '';
  const [text, setText] = useState(initial.message?.text ?? '');
  const [emoji, setEmoji] = useState<string | null>(initial.message?.emoji ?? null);
  const [clear, setClear] = useState<Clear>(initial.message?.expiresAt ? 'today' : 'never');
  const [visibility, setVisibility] = useState<StatusVisibility>(initial.visibility);
  // How long the chosen state lasts; afterwards the server shows activity again.
  const [lasts, setLasts] = useState<Clear>(
    initial.visibility !== 'online' && !initial.visibilityUntil ? 'never' : '1h',
  );
  const keepsUntil = initial.visibility === visibility && initial.visibilityUntil !== null;
  const [autoMeeting, setAutoMeeting] = useState(initial.autoMeeting);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.call('updateMyStatus', {
        body: {
          visibility,
          visibilityUntil:
            visibility === 'online'
              ? null
              : keepsUntil && lasts === '1h'
                ? initial.visibilityUntil
                : clearAt(lasts),
          message: text.trim() ? { text: text.trim(), emoji, expiresAt: clearAt(clear) } : null,
          autoMeeting,
        },
      });
      qc.setQueryData(chatKeys.myStatus, next);
      // Reflect it at once on my own avatar; the server confirms with a presence event.
      if (me) {
        const state = visibility === 'invisible' ? 'offline' : visibility;
        setPresence([
          {
            userId: me,
            state,
            auto: null,
            message: next.message,
            lastSeenAt: new Date().toISOString(),
            device: 'web',
            until: state === 'offline' ? null : next.visibilityUntil,
          },
        ]);
      }
      openStatusDialog(false);
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 rounded-lg px-2 py-1 shadow-line2 focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]">
        <EmojiPicker onPick={setEmoji} align="start">
          <IconButton size="sm" tone="plain" aria-label={t('chat.status.emoji')}>
            {emoji ? <span className="text-[17px]">{emoji}</span> : <Icon name="smile" size={18} />}
          </IconButton>
        </EmojiPicker>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={100}
          placeholder={t('chat.status.placeholder')}
          aria-label={t('chat.status.message')}
          className="h-9 flex-1 border-0 bg-transparent px-0 shadow-none focus:shadow-none"
        />
        {text ? (
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('chat.status.clearMessage')}
            onClick={() => {
              setText('');
              setEmoji(null);
            }}
          >
            <Icon name="x" size={14} />
          </IconButton>
        ) : null}
      </div>
      <div className="flex items-center gap-3 text-cap">
        <span className="font-semibold">{t('chat.status.clearAfter')}</span>
        <Select value={clear} onValueChange={(v) => setClear(v as Clear)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLEARS.map((c) => (
              <SelectItem key={c} value={c}>
                {t(`chat.status.clears.${c}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
          {t('chat.status.suggestions')}
        </span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => {
              setText(t(`chat.status.suggest.${s.key}`));
              setEmoji(s.emoji);
              setClear(s.clear);
            }}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-cap hover:bg-bg2"
          >
            <span className="text-[16px]">{s.emoji}</span>
            <span className="font-semibold">{t(`chat.status.suggest.${s.key}`)}</span>
            <span className="text-fg2">{t(`chat.status.clears.${s.clear}`)}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
          {t('chat.status.visibility')}
        </span>
        <RadioGroup
          value={visibility}
          onValueChange={(v) => setVisibility(v as StatusVisibility)}
          className="flex flex-col gap-0.5"
        >
          {VISIBILITY.map((v) => (
            <label
              key={v}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-bg2',
              )}
            >
              <Radio value={v} aria-label={t(`chat.status.visibilities.${v}`)} className="mt-0.5" />
              <span
                className={cn(
                  'mt-1 size-2.5 shrink-0 rounded-full',
                  v === 'online'
                    ? 'bg-success'
                    : v === 'away'
                      ? 'bg-warning'
                      : v === 'invisible'
                        ? 'bg-fg3'
                        : 'bg-danger',
                )}
              />
              <span className="flex flex-col">
                <span className="text-cap font-semibold">{t(`chat.status.visibilities.${v}`)}</span>
                {v === 'busy' || v === 'dnd' || v === 'invisible' ? (
                  <span className="text-xs text-fg2">{t(`chat.status.hints.${v}`)}</span>
                ) : null}
              </span>
            </label>
          ))}
        </RadioGroup>
        {visibility !== 'online' ? (
          <div className="flex items-center gap-3 pl-2 text-cap">
            <span className="font-semibold">{t('chat.status.lasts')}</span>
            <Select value={lasts} onValueChange={(v) => setLasts(v as Clear)}>
              <SelectTrigger className="w-[200px]" aria-label={t('chat.status.lasts')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLEARS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`chat.status.durations.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      <label className="flex items-center justify-between gap-3 text-cap">
        <span className="flex flex-col">
          <span className="font-semibold">{t('chat.status.autoMeeting')}</span>
          <span className="text-xs text-fg2">{t('chat.status.autoMeetingHint')}</span>
        </span>
        <Switch
          checked={autoMeeting}
          onCheckedChange={setAutoMeeting}
          aria-label={t('chat.status.autoMeeting')}
        />
      </label>
      <DialogFooter>
        <Button variant="gh" onClick={() => openStatusDialog(false)}>
          {t('common.actions.cancel')}
        </Button>
        <Button variant="inv" loading={busy} onClick={() => void save()}>
          {t('common.actions.save')}
        </Button>
      </DialogFooter>
    </div>
  );
}
