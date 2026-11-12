import {
  CHAT_COMMANDS,
  parsePollInput,
  parseReminder,
  parseWhen,
  POLL_LIMITS,
  type ChatCommand,
} from '@crewhall/shared';
import {
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
  toast,
  type IconName,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api, idempotencyKey } from '@/lib/api';
import { noteNewMessage, putMessages } from '@/lib/chat/cache';
import { excerptOf } from '@/lib/chat/names';
import { ALL } from '@/lib/chat/text';
import { type Conversation } from '@/lib/chat/types';
import { useModuleEnabled } from '@/lib/identity/modules';
import { meetKeys } from '@/lib/meet/queries';
import { newId } from '@/lib/ids';
import { errorKey } from '@/lib/errors';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useOpenMeeting } from '@/components/meet/openMeeting';
import { useGifEnabled } from './gif';

/**
 * Slash commands in the composer (roadmap 23, Teams-like chat kept). Typing `/` at the start
 * opens the menu; a known command as the first word runs on Enter, anything else goes as text.
 */

export const COMMAND_ICONS: Record<ChatCommand, IconName> = {
  meet: 'video',
  remind: 'clock',
  poll: 'list',
  me: 'user',
  whisper: 'lock',
  zamanla: 'send',
  gif: 'image',
};

/** Direct and group chats call; space chats start a meeting (as the header buttons do). */
const CALL_TYPES: ReadonlySet<Conversation['type']> = new Set(['direct', 'group']);

/** The commands that make sense in this conversation. */
export function useAvailableCommands(conv: Conversation): ChatCommand[] {
  const meetOn = useModuleEnabled('meet');
  const gifOn = useGifEnabled();
  const { role } = usePermissions();
  const canMeet =
    meetOn && role !== 'guest' && (CALL_TYPES.has(conv.type) || conv.type === 'space');
  return CHAT_COMMANDS.filter((c) => {
    if (c === 'meet') return canMeet;
    if (c === 'whisper') return conv.type !== 'direct' && conv.memberCount > 2;
    if (c === 'gif') return gifOn;
    return true;
  });
}

/** What the composer does after a command ran. */
export type CommandOutcome =
  | { kind: 'send'; text: string; emote?: boolean; whisperTo?: string }
  | { kind: 'done' }
  | { kind: 'keep' }
  /** `/zamanla`: schedule `text` at `at`; without a time (or text) the picker opens. */
  | { kind: 'schedule'; at: Date | null; text: string }
  /** `/gif <kelime>`: the GIF picker opens with this search. */
  | { kind: 'gif'; query: string };

const WHISPER_RE = /^<@([0-9a-f-]{36})>\s*([\s\S]*)$/i;
const VOICE_WORDS = new Set(['sesli', 'ses', 'voice', 'audio']);

export function useSlashCommands(conv: Conversation, openPoll: (rest: string) => void) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const openMeeting = useOpenMeeting();
  const available = useAvailableCommands(conv);

  const fail = useCallback((e: unknown) => toast.error(t(errorKey(e))), [t]);

  const meet = useCallback(
    async (rest: string) => {
      if (!available.includes('meet')) {
        toast.error(t('chat.commands.meetUnavailable'));
        return false;
      }
      try {
        if (CALL_TYPES.has(conv.type)) {
          const video = !VOICE_WORDS.has(rest.trim().toLocaleLowerCase(locale));
          const call = await api.call('startCall', {
            body: { conversationId: conv.id, video },
            idempotencyKey: idempotencyKey(),
          });
          openMeeting(call.slug, { call: call.id });
        } else {
          const m = await api.call('createMeeting', {
            body: { mode: 'instant', conversationId: conv.id },
            idempotencyKey: idempotencyKey(),
          });
          await qc.invalidateQueries({ queryKey: meetKeys.all });
          openMeeting(m.slug);
        }
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [available, conv.id, conv.type, fail, locale, openMeeting, qc, t],
  );

  const remind = useCallback(
    async (rest: string) => {
      const parsed = parseReminder(rest);
      if (!parsed) {
        toast.error(t('chat.commands.remindInvalid'));
        return false;
      }
      try {
        const r = await api.call('createChatReminder', {
          body: {
            conversationId: conv.id,
            text: parsed.text,
            remindAt: parsed.at.toISOString(),
          },
        });
        const when = formatDate(parsed.at, locale, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
        toast(t('chat.commands.remindSet', { when }), {
          description: parsed.text || undefined,
          action: {
            label: t('chat.commands.undo'),
            onClick: () =>
              void api.call('deleteChatReminder', { params: { reminderId: r.id } }).catch(fail),
          },
        });
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [conv.id, fail, locale, t],
  );

  const poll = useCallback(
    async (rest: string) => {
      const { question, options } = parsePollInput(rest);
      if (!question || options.length < POLL_LIMITS.minOptions) {
        openPoll(rest);
        return true;
      }
      return createPollMessage(qc, conv.id, { question, options, multiple: false })
        .then(() => true)
        .catch((e: unknown) => {
          fail(e);
          return false;
        });
    },
    [conv.id, fail, openPoll, qc],
  );

  /** `text` carries mention tokens (`<@id>`), as the composer sends them. */
  return useCallback(
    async (command: ChatCommand, rest: string): Promise<CommandOutcome> => {
      switch (command) {
        case 'meet':
          return (await meet(rest)) ? { kind: 'done' } : { kind: 'keep' };
        case 'remind':
          return (await remind(rest)) ? { kind: 'done' } : { kind: 'keep' };
        case 'poll':
          return (await poll(rest)) ? { kind: 'done' } : { kind: 'keep' };
        case 'me':
          if (!rest) {
            toast.error(t('chat.commands.emptyText'));
            return { kind: 'keep' };
          }
          return { kind: 'send', text: rest, emote: true };
        case 'whisper': {
          if (!available.includes('whisper')) {
            toast.error(t('chat.commands.whisperDirect'));
            return { kind: 'keep' };
          }
          const m = WHISPER_RE.exec(rest);
          if (!m || m[1] === ALL) {
            toast.error(t('chat.commands.whisperNeedsPerson'));
            return { kind: 'keep' };
          }
          if (!m[2]?.trim()) {
            toast.error(t('chat.commands.emptyText'));
            return { kind: 'keep' };
          }
          return { kind: 'send', text: m[2].trim(), whisperTo: m[1]! };
        }
        case 'gif':
          if (!available.includes('gif')) {
            toast.error(t('chat.gif.off'));
            return { kind: 'keep' };
          }
          return { kind: 'gif', query: rest };
        case 'zamanla': {
          const parsed = parseWhen(rest);
          return parsed
            ? { kind: 'schedule', at: parsed.at, text: parsed.text }
            : { kind: 'schedule', at: null, text: rest };
        }
      }
    },
    [available, meet, poll, remind, t],
  );
}

async function createPollMessage(
  qc: ReturnType<typeof useQueryClient>,
  conversationId: string,
  body: { question: string; options: string[]; multiple: boolean },
) {
  const msg = await api.call('createPoll', {
    params: { conversationId },
    body: { clientMsgId: newId(), ...body },
  });
  putMessages(qc, conversationId, [msg]);
  const me = msg.author?.id ?? '';
  noteNewMessage(qc, msg, me, { reading: true, excerpt: excerptOf(msg) });
  return msg;
}

/** `/poll` without a full "Soru | A | B" line: question, 2-10 options, several allowed or not. */
export function PollDialog({
  conv,
  initial,
  open,
  onOpenChange,
}: {
  conv: Conversation;
  initial: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const seed = parsePollInput(initial);
  const [question, setQuestion] = useState(seed.question);
  const [options, setOptions] = useState<string[]>(
    [...seed.options, '', ''].slice(0, Math.max(POLL_LIMITS.minOptions, seed.options.length)),
  );
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const ready = question.trim().length > 0 && filled.length >= POLL_LIMITS.minOptions;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await createPollMessage(qc, conv.id, {
        question: question.trim(),
        options: filled,
        multiple,
      });
      onOpenChange(false);
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={460}>
        <DialogHeader title={t('chat.poll.dialogTitle')} description={t('chat.poll.dialogHint')} />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={t('chat.poll.question')}>
            <Input
              autoFocus
              value={question}
              maxLength={POLL_LIMITS.questionChars}
              placeholder={t('chat.poll.questionPlaceholder')}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                className="flex-1"
                value={o}
                maxLength={POLL_LIMITS.optionChars}
                aria-label={t('chat.poll.option', { n: i + 1 })}
                placeholder={t('chat.poll.option', { n: i + 1 })}
                onChange={(e) =>
                  setOptions((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))
                }
              />
              {options.length > POLL_LIMITS.minOptions ? (
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('chat.poll.removeOption', { n: i + 1 })}
                  onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={14} />
                </IconButton>
              ) : null}
            </div>
          ))}
          {options.length < POLL_LIMITS.maxOptions ? (
            <Button
              type="button"
              variant="gh"
              className="self-start"
              onClick={() => setOptions((cur) => [...cur, ''])}
            >
              <Icon name="plus" size={14} />
              {t('chat.poll.addOption')}
            </Button>
          ) : null}
          <CheckboxRow checked={multiple} onCheckedChange={(v) => setMultiple(v === true)}>
            {t('chat.poll.allowMultiple')}
          </CheckboxRow>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" disabled={!ready || busy}>
              {t('chat.poll.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
