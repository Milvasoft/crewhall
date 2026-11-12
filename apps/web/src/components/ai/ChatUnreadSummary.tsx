import { Button, Icon, Spinner } from '@crewhall/ui';
import { useState } from 'react';
import { AiSetupHint } from '@/components/ai/AiSetupHint';
import { useAiAvailability } from '@/lib/ai/availability';
import { useAiRun } from '@/lib/ai/useAiRun';
import { useI18n } from '@/lib/i18n/I18nContext';

/** From this many unread messages on, the "Yeni mesajlar" divider offers a summary. */
const MIN_UNREAD = 3;

/**
 * "Okunmamışları özetle" under the chat's "Yeni mesajlar" divider (yol haritası #5). The server
 * builds the transcript itself from the messages this person can see after `afterSeq` (the
 * divider), so nothing they cannot read reaches the model.
 */
export function ChatUnreadSummary({
  conversationId,
  afterSeq,
  unread,
}: {
  conversationId: string;
  afterSeq: number;
  unread: number;
}) {
  const { t, locale } = useI18n();
  const availability = useAiAvailability();
  const { state, run, cancel, reset } = useAiRun();
  const [open, setOpen] = useState(false);
  if (unread < MIN_UNREAD) return null;
  if (!availability.visible) {
    return availability.setupHint ? (
      <div className="flex justify-center px-6 pt-2">
        <AiSetupHint />
      </div>
    ) : null;
  }

  const start = () => {
    setOpen(true);
    void run({ action: 'summarize_unread', conversationId, afterSeq, locale });
  };

  if (!open) {
    return (
      <div className="flex justify-center px-6 pt-2">
        <Button
          size="xs"
          variant="out"
          disabled={!availability.usable}
          title={availability.usable ? t('ai.chat.summarizeHint') : t('ai.menu.quota')}
          onClick={start}
        >
          <Icon name="sparkle" size={14} className="text-accent-text" />
          {t('ai.chat.summarize', { count: unread })}
        </Button>
      </div>
    );
  }

  const running = state.status === 'running';
  return (
    <section
      aria-label={t('ai.chat.title')}
      className="mx-6 mt-2 flex animate-fade-in flex-col gap-2 rounded-xl bg-accent10 px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <Icon name="sparkle" size={15} className="text-accent-text" />
        <span className="flex-1 text-cap font-semibold">{t('ai.chat.title')}</span>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-fg2 hover:bg-bg2"
          aria-label={t('ai.preview.close')}
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="text-sm whitespace-pre-wrap" aria-live="polite" aria-busy={running}>
        {state.status === 'done' && state.messages === 0 ? t('ai.chat.nothing') : state.text}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg2">
        {running ? (
          <>
            <Spinner size={14} /> {t('ai.preview.writing')}
            <Button size="xs" variant="gh" onClick={cancel}>
              {t('ai.preview.stop')}
            </Button>
          </>
        ) : state.status === 'error' ? (
          <>
            <span className="text-danger" role="alert">
              {t(`errors.${state.error ?? 'internal'}`)}
            </span>
            <Button size="xs" variant="gh" onClick={start}>
              {t('ai.preview.retry')}
            </Button>
          </>
        ) : (
          <span>
            {state.messages ? `${t('ai.chat.messages', { count: state.messages })} · ` : ''}
            {t('ai.chat.privacy')}
          </span>
        )}
      </div>
    </section>
  );
}
