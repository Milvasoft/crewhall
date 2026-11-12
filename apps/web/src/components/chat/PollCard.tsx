import { cn, Icon, toast, Tooltip } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { patchMessage, putMessages } from '@/lib/chat/cache';
import { nameOf } from '@/lib/chat/names';
import { type Conversation, type Message } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

type Poll = NonNullable<Message['poll']>;

/** `/poll` (roadmap 23): options with live bars; a click votes, the counts come over the socket. */
export function PollCard({
  m,
  poll,
  me,
  conv,
}: {
  m: Message;
  poll: Poll;
  me: string;
  conv: Conversation;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const mine = poll.options.filter((o) => o.userIds.includes(me)).map((o) => o.index);
  const closed = poll.closedAt !== null;
  const canVote = !closed && !conv.archivedAt && conv.permissions.write;
  const canClose = !closed && (poll.createdBy === me || conv.permissions.moderate);
  const top = Math.max(1, ...poll.options.map((o) => o.count));

  const apply = (next: Message) => {
    putMessages(qc, next.conversationId, [next]);
    patchMessage(qc, next.conversationId, next.id, () => next);
  };
  const vote = async (options: number[]) => {
    setBusy(true);
    try {
      apply(await api.call('votePoll', { params: { pollId: poll.id }, body: { options } }));
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (index: number) => {
    if (!canVote || busy) return;
    const on = mine.includes(index);
    if (poll.multiple) void vote(on ? mine.filter((i) => i !== index) : [...mine, index]);
    else void vote(on ? [] : [index]);
  };
  const close = async () => {
    try {
      apply(await api.call('closePoll', { params: { pollId: poll.id } }));
      toast(t('chat.poll.closedToast'));
    } catch (e) {
      toast.error(t(errorKey(e)));
    }
  };

  return (
    <div data-no-quick-react="" className="flex w-[min(420px,100%)] flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-[.06em] text-fg2 uppercase">
        <Icon name="list" size={13} />
        {t('chat.poll.label')}
        {poll.multiple ? (
          <span className="font-semibold tracking-normal normal-case">
            · {t('chat.poll.multiple')}
          </span>
        ) : null}
      </div>
      <p className="m-0 text-[14.5px] leading-5 font-bold break-words">{poll.question}</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={poll.question}>
        {poll.options.map((o) => {
          const chosen = mine.includes(o.index);
          const names = o.userIds.map((id) => nameOf(id) ?? t('chat.mention.unknown'));
          const row = (
            <button
              type="button"
              role={poll.multiple ? 'checkbox' : 'radio'}
              aria-checked={chosen}
              disabled={!canVote || busy}
              onClick={() => toggle(o.index)}
              className={cn(
                'relative flex w-full items-center gap-2 overflow-hidden rounded-lg bg-bg px-3 py-2 text-left text-cap shadow-line transition-shadow duration-(--t-fast)',
                canVote && 'hover:shadow-line2',
                chosen && 'shadow-[inset_0_0_0_1.5px_var(--fg)]',
              )}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-accent10 transition-[width] duration-300"
                style={{ width: `${Math.round((o.count / top) * 100)}%` }}
              />
              <span
                className={cn(
                  'relative flex size-4 shrink-0 items-center justify-center border border-line2',
                  poll.multiple ? 'rounded' : 'rounded-full',
                  chosen && 'border-fg bg-fg text-bg',
                )}
              >
                {chosen ? <Icon name="check" size={10} strokeWidth={3} /> : null}
              </span>
              <span className="relative min-w-0 flex-1 break-words">{o.text}</span>
              <span className="relative text-xs font-bold text-fg2 tabular-nums">{o.count}</span>
            </button>
          );
          return (
            <li key={o.index}>
              {names.length ? (
                <Tooltip content={t('chat.poll.votedBy', { names: names.join(', ') })}>
                  {row}
                </Tooltip>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg2">
        <span>{t('chat.poll.voters', { count: poll.voterCount })}</span>
        {closed ? <span className="font-bold">{t('chat.poll.closed')}</span> : null}
        {canVote && mine.length ? (
          <button
            type="button"
            className="font-semibold hover:underline"
            disabled={busy}
            onClick={() => void vote([])}
          >
            {t('chat.poll.retract')}
          </button>
        ) : null}
        {canClose && !m.deletedAt ? (
          <button
            type="button"
            className="font-semibold hover:underline"
            onClick={() => void close()}
          >
            {t('chat.poll.close')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
