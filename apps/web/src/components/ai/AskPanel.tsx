import {
  AI_LIMITS,
  type AiActProposal,
  type AiCitation,
  type AiSearchKind,
} from '@crewhall/shared';
import {
  Button,
  cn,
  Icon,
  IconButton,
  Segmented,
  Spinner,
  Tooltip,
  type IconName,
} from '@crewhall/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  closeAsk,
  hitLocation,
  openAsk,
  useActConversation,
  useAskConversation,
  useAskMode,
  useAskPanel,
  type ActTurn,
} from '@/lib/ai/ask';
import { askDraft, keepAskDraft } from '@/lib/ai/conversation';
import { ActProposal } from '@/components/ai/ActProposal';
import { PaneEdge, paneStyle, usePaneSize } from '@/components/shell/ResizablePane';
import { useModuleEnabled } from '@/lib/identity/modules';
import { isReducedMotion } from '@/lib/motion';
import { useAiAvailability } from '@/lib/ai/availability';
import { requestDecisions } from '@/lib/ai/decisions';
import { dictationEngine, useDictation } from '@/lib/ai/dictation';
import { approvalQuery } from '@/lib/mcp/queries';
import { asCode } from '@/lib/ai/useAiRun';
import { formatRelative, formatTime, formatWeekdayDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesQuery } from '@/lib/queries';

export const KIND_ICON: Record<AiSearchKind, IconName> = {
  page: 'page',
  file: 'file',
  folder: 'folder',
  board: 'board',
  drawing: 'pencil',
  card: 'card',
  message: 'chat',
  event: 'calendar',
  meeting: 'video',
  todo: 'todo',
  person: 'user',
  row: 'table',
  contact: 'id',
  mail: 'mail',
};

/** "Bugün 14:00", "Yarın 09:30", "Cuma, 30 Ekim 10:00" (no time at midnight: all-day items). */
function whenLabel(
  at: string,
  locale: 'tr' | 'en',
  t: ReturnType<typeof useI18n>['t'],
  now = new Date(),
) {
  const d = new Date(at);
  const dayOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayOf(d) - dayOf(now)) / 86_400_000);
  const time = d.getHours() || d.getMinutes() ? formatTime(d, locale) : '';
  if (days === 0) return t('ai.ask.when.today', { time }).trim();
  if (days === 1) return t('ai.ask.when.tomorrow', { time }).trim();
  if (days === -1) return t('ai.ask.when.yesterday', { time }).trim();
  return `${formatWeekdayDate(d, locale)}${time ? ` ${time}` : ''}`;
}

/**
 * Top bar button of "Crewhall'a sor"; hidden while AI is off. While it is on but not set up,
 * admins get the button with a way to the settings instead.
 */
export function AskButton() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { visible, setupHint } = useAiAvailability();
  const panel = useAskPanel();
  if (setupHint) {
    return (
      <IconButton
        size="sm"
        tone="plain"
        aria-label={t('ai.setup.hint')}
        title={t('ai.setup.hint')}
        onClick={() => void navigate({ to: '/admin/ai' })}
      >
        <Icon name="sparkle" size={18} className="text-fg3" />
      </IconButton>
    );
  }
  if (!visible) return null;
  return (
    <IconButton
      size="sm"
      tone="plain"
      aria-label={t('ai.ask.open')}
      title={t('ai.ask.open')}
      data-ask-toggle=""
      onClick={() => (panel.open ? closeAsk() : openAsk())}
    >
      <Icon name="sparkle" size={18} />
    </IconButton>
  );
}

/**
 * "Crewhall'a sor" side panel (yol haritası #11): questions answered from the person's own
 * pages, files, boards and chats, each statement citing its source. Ctrl J toggles it.
 */
export function AskPanel() {
  const { visible } = useAiAvailability();
  const panel = useAskPanel();

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (panel.open) closeAsk();
        else openAsk();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, panel.open]);

  const open = visible && panel.open;
  // Stays mounted after closing until the slide-out has played.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  if (!mounted) return null;
  return createPortal(
    <PanelBody initial={panel.question} open={open} onClosed={() => setMounted(false)} />,
    document.body,
  );
}

/** A motion token in milliseconds (`--t-panel: 240ms`), or the fallback outside a browser. */
function motionMs(token: string, fallback: number) {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token));
  return Number.isFinite(value) ? value : fallback;
}

/** A desktop side sheet's curve (macOS, Windows 11): fast off the edge, a long soft landing. */
const SHEET_IN = 'cubic-bezier(0.32, 0.72, 0, 1)';
const SHEET_OUT = 'cubic-bezier(0.4, 0, 1, 1)';

/**
 * The panel slides in from the right on a desktop sheet curve (~340 ms) and its header,
 * conversation and composer follow it in, 45 ms apart, as it lands; it leaves faster (~200 ms,
 * accelerating). `onClosed` unmounts it afterwards. Reduced motion: a short fade, no movement.
 */
function useSlideIn(open: boolean, onClosed: () => void) {
  const ref = useRef<HTMLElement>(null);
  const closed = useRef(onClosed);
  useLayoutEffect(() => {
    closed.current = onClosed;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el?.animate) {
      if (!open) closed.current();
      return;
    }
    const reduced = isReducedMotion();
    if (open) {
      if (reduced) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
        return;
      }
      const slide = motionMs('--t-panel', 240) + 100;
      el.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], {
        duration: slide,
        easing: SHEET_IN,
      });
      // The panel's sections (not the resize edge) settle in after it, left to right in time.
      const parts = [...el.children].filter((c) => c.getAttribute('role') !== 'separator');
      parts.forEach((part, i) =>
        part.animate(
          [
            { opacity: 0, transform: 'translateX(16px)' },
            { opacity: 1, transform: 'translateX(0)' },
          ],
          { duration: 260, delay: slide * 0.3 + i * 45, easing: SHEET_IN, fill: 'backwards' },
        ),
      );
      return;
    }
    const out = reduced
      ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' })
      : el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], {
          duration: motionMs('--t-base', 180) + 20,
          easing: SHEET_OUT,
          fill: 'forwards',
        });
    out.onfinish = () => closed.current();
    return () => out.cancel();
  }, [open]);
  return ref;
}

/** Not "outside": the button that toggles the panel, and toasts, which belong to no one. */
const NOT_OUTSIDE = '[data-ask-toggle], [data-sonner-toaster]';

/**
 * Closes the panel when a press lands outside it, on the press and not on the click: selecting
 * text in the panel and letting go outside it is a click out there. The panel's own menus and
 * dialogs live in portals, but their events still pass through it in React's tree, which is how
 * they are told from the rest of the page. The press still reaches what is under it, so a row
 * can be opened in one click. A dictation in progress keeps the panel open: closing drops it.
 */
function useCloseOnOutsidePress(open: boolean, recording: () => boolean) {
  const own = useRef<Event | null>(null);
  const isRecording = useRef(recording);
  useLayoutEffect(() => {
    isRecording.current = recording;
  });
  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      if (e === own.current || isRecording.current()) return;
      if (e.target instanceof Element && e.target.closest(NOT_OUTSIDE)) return;
      closeAsk();
    };
    document.addEventListener('pointerdown', onPress);
    return () => document.removeEventListener('pointerdown', onPress);
  }, [open]);
  return (e: ReactPointerEvent) => {
    own.current = e.nativeEvent;
  };
}

function PanelBody({
  initial,
  open,
  onClosed,
}: {
  initial: string | null;
  open: boolean;
  onClosed: () => void;
}) {
  const sheet = useSlideIn(open, onClosed);
  // Wider for long answers and tables; phones keep the full width (min with 100vw).
  const pane = usePaneSize('ask', 'right', 488, 360, true);
  const { t, locale } = useI18n();
  const { turns, ask, stop, reset, retry } = useAskConversation();
  const act = useActConversation();
  const actOn = useModuleEnabled('mcp');
  const [mode, setMode] = useAskMode();
  const acting = mode === 'act' && actOn;
  // Read after the conversation above is bound to this person, whose draft it is.
  const [draft, setDraft] = useState(askDraft);
  const asked = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const { usable, status } = useAiAvailability();
  const dictation = useDictation({
    engine: dictationEngine(!!status?.dictation),
    locale,
    value: draft,
    onChange: setDraft,
  });
  // The window listener below reads the dictation through this (it is set up once).
  const dictating = useRef(dictation);
  useLayoutEffect(() => {
    dictating.current = dictation;
  });
  const running = acting
    ? act.turns.some((x) => x.status === 'running')
    : turns.some((x) => x.status === 'running');

  const onOwnPress = useCloseOnOutsidePress(open, () => dictating.current.active);

  useEffect(() => keepAskDraft(draft), [draft]);

  useEffect(() => {
    if (initial && asked.current !== initial) {
      asked.current = initial;
      void ask(initial);
    }
  }, [initial, ask]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [turns]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 136)}px`;
  }, [draft]);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const d = dictating.current;
      if (e.key === 'Escape') {
        // A menu or dialog over the panel took this one, or an input method is composing.
        if (e.defaultPrevented || e.isComposing) return;
        // Esc first cancels a dictation, then closes the panel.
        if (d.active) {
          e.preventDefault();
          d.cancel();
        } else closeAsk();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        if (d.engine === 'none') return;
        e.preventDefault();
        d.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = () => {
    const q = draft.trim();
    if (!q || running || dictation.active) return;
    setDraft('');
    if (acting) void act.run(q);
    else void ask(q);
  };

  return (
    <aside
      ref={sheet}
      role="dialog"
      aria-label={t('ai.ask.title')}
      // Desktop app: starts under the window buttons (index.css).
      data-desktop-side-panel=""
      onPointerDownCapture={onOwnPress}
      style={paneStyle(pane)}
      className="fixed inset-y-0 right-0 z-50 flex w-[min(var(--pane-w),100vw)] flex-col border-l border-line bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-overlay will-change-transform"
    >
      <PaneEdge size={pane} target={sheet} />
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <Icon name="sparkle" size={18} className="text-accent-text" />
        <Tooltip content={t('ai.ask.toggleHint')}>
          <h2 className="m-0 flex-1 cursor-default text-sm font-semibold">{t('ai.ask.title')}</h2>
        </Tooltip>
        {(acting ? act.turns.length : turns.length) ? (
          <Button size="xs" variant="gh" onClick={acting ? act.reset : reset}>
            {t('ai.ask.new')}
          </Button>
        ) : null}
        <IconButton size="sm" tone="plain" aria-label={t('ai.preview.close')} onClick={closeAsk}>
          <Icon name="x" size={16} />
        </IconButton>
      </header>
      {actOn ? (
        <div className="shrink-0 border-b border-line px-4 py-2">
          <Segmented
            size="sm"
            value={mode}
            onValueChange={setMode}
            aria-label={t('ai.ask.mode')}
            options={[
              { value: 'ask', label: t('ai.ask.modeAsk') },
              { value: 'act', label: t('ai.ask.modeAct') },
            ]}
          />
        </div>
      ) : null}

      <div
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {acting ? <ActTurns turns={act.turns} onRetry={act.retry} /> : null}
        {!acting && turns.length === 0 ? (
          <div className="flex flex-col gap-3 pt-6 text-center">
            <Icon name="sparkle" size={28} className="mx-auto text-accent-text" />
            <p className="m-0 text-sm font-semibold">{t('ai.ask.emptyTitle')}</p>
            <p className="m-0 text-xs text-fg2">{t('ai.ask.emptyBody')}</p>
            <div className="flex flex-wrap justify-center gap-1.5 pt-2">
              {(['e1', 'e2', 'e3'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="rounded-full bg-bg2 px-3 py-1.5 text-xs hover:bg-capsule"
                  onClick={() => void ask(t(`ai.ask.examples.${k}`))}
                >
                  {t(`ai.ask.examples.${k}`)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {(acting ? [] : turns).map((turn) => (
          <section key={turn.id} className="flex flex-col gap-2.5">
            <p className="m-0 self-end rounded-2xl rounded-br-md bg-accent10 px-3 py-2 text-sm">
              {turn.question}
            </p>
            <div className="text-sm whitespace-pre-wrap">
              <Cited text={turn.answer} citations={turn.citations} />
              {turn.status === 'running' && !turn.answer ? (
                <span className="flex items-center gap-1.5 text-xs text-fg2">
                  <Spinner size={14} />
                  {turn.citations.length ? t('ai.ask.writing') : t('ai.ask.searching')}
                </span>
              ) : null}
            </div>
            {turn.status === 'error' ? (
              <p role="alert" className="m-0 text-xs text-danger">
                {t(`errors.${turn.error ?? 'internal'}`)}
              </p>
            ) : null}
            {turn.status === 'interrupted' ? <Interrupted onRetry={() => retry(turn)} /> : null}
            {turn.citations.length ? <Sources citations={turn.citations} /> : null}
            {turn.status === 'done' && turn.citations.length === 0 ? (
              <p className="m-0 text-xs text-fg2">{t('ai.ask.noSources')}</p>
            ) : null}
          </section>
        ))}
        <div ref={end} />
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
        <DictationStatus dictation={dictation} />
        <div className="flex items-end gap-1 rounded-xl bg-bg py-1.5 pr-1.5 pl-3.5 shadow-line2 transition-shadow duration-[var(--t-fast)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            maxLength={AI_LIMITS.questionChars}
            placeholder={acting ? t('ai.act.placeholder') : t('ai.ask.placeholder')}
            aria-label={acting ? t('ai.act.placeholder') : t('ai.ask.placeholder')}
            className="max-h-[136px] min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] leading-5 outline-none placeholder:text-fg3 focus-visible:shadow-none focus-visible:outline-none"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <DictationButton dictation={dictation} disabled={!usable} />
          {running && !acting ? (
            <IconButton
              size="sm"
              aria-label={t('ai.preview.stop')}
              title={t('ai.preview.stop')}
              onClick={stop}
              className="rounded-full bg-fg text-bg hover:bg-fg"
            >
              <Icon name="pause" size={15} />
            </IconButton>
          ) : (
            <IconButton
              size="sm"
              aria-label={t('ai.ask.send')}
              title={t('ai.ask.send')}
              disabled={!draft.trim() || !usable || running || dictation.active}
              onClick={submit}
              className="rounded-full bg-accent text-accent-fg hover:bg-accent disabled:bg-bg2 disabled:text-fg3"
            >
              <Icon name="send" size={15} />
            </IconButton>
          )}
        </div>
        <div className="flex items-center gap-2 px-1 text-[11px] text-fg3">
          <span className="min-w-0 flex-1 truncate">
            {usable ? t('ai.ask.privacy') : t('ai.menu.quota')}
          </span>
          <span className="shrink-0 pointer-coarse:hidden">{t('ai.ask.keys')}</span>
        </div>
      </footer>
    </aside>
  );
}

type Dictation = ReturnType<typeof useDictation>;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Microphone: starts and stops sesle yazma; disabled with the reason where it cannot work. */
function DictationButton({ dictation, disabled }: { dictation: Dictation; disabled: boolean }) {
  const { t } = useI18n();
  const unavailable = dictation.engine === 'none';
  const listening = dictation.phase === 'listening';
  const label = unavailable
    ? t('ai.dictation.needsServer')
    : listening
      ? t('ai.dictation.stop')
      : t('ai.dictation.start');
  return (
    <IconButton
      size="sm"
      tone={listening ? 'filled' : 'plain'}
      className={listening ? 'text-danger' : undefined}
      aria-label={label}
      aria-pressed={listening}
      aria-keyshortcuts="Control+Shift+M Meta+Shift+M"
      title={unavailable ? label : `${label} (Ctrl Shift M)`}
      disabled={disabled || unavailable || dictation.phase === 'transcribing'}
      onClick={dictation.toggle}
    >
      <Icon name={listening ? 'record' : unavailable ? 'micOff' : 'mic'} size={17} />
    </IconButton>
  );
}

/** The recording light with its time, "yazıya çevriliyor", or what went wrong. */
function DictationStatus({ dictation }: { dictation: Dictation }) {
  const { t } = useI18n();
  if (dictation.phase === 'listening') {
    return (
      <div role="status" className="flex items-center gap-2 text-xs">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-danger" />
        </span>
        <span className="font-semibold">{t('ai.dictation.listening')}</span>
        <span className="text-fg2 tabular-nums">
          {clock(dictation.seconds)} / {clock(AI_LIMITS.dictationSeconds)}
        </span>
        <span className="ml-auto text-fg3">{t('ai.dictation.escCancels')}</span>
      </div>
    );
  }
  if (dictation.phase === 'transcribing') {
    return (
      <div role="status" className="flex items-center gap-2 text-xs text-fg2">
        <Spinner size={13} /> {t('ai.dictation.transcribing')}
      </div>
    );
  }
  if (!dictation.error) return null;
  const e = dictation.error;
  return (
    <div role="alert" className="flex items-center gap-2 text-xs text-danger">
      <Icon name="alert" size={13} />
      <span className="flex-1">
        {typeof e === 'string' ? t(`ai.dictation.errors.${e}`) : t(`errors.${asCode(e.code)}`)}
      </span>
      <IconButton
        size="sm"
        tone="plain"
        aria-label={t('ai.preview.close')}
        onClick={dictation.clearError}
      >
        <Icon name="x" size={13} />
      </IconButton>
    </div>
  );
}

/** A turn whose page went away while it was running (reload, closed tab). */
function Interrupted({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <p className="m-0 flex items-center gap-1.5 text-xs text-fg2">
      <Icon name="alert" size={13} className="text-warning" />
      {t('ai.ask.interrupted')} ·
      <button
        type="button"
        className="font-semibold text-accent-text underline-offset-2 hover:underline"
        onClick={onRetry}
      >
        {t('ai.ask.retry')}
      </button>
    </p>
  );
}

/** "Yap" mode: what the assistant prepared, each waiting in the approval queue. */
function ActTurns({ turns, onRetry }: { turns: ActTurn[]; onRetry: (turn: ActTurn) => void }) {
  const { t } = useI18n();
  if (turns.length === 0) {
    return (
      <div className="flex flex-col gap-3 pt-6 text-center">
        <Icon name="zap" size={28} className="mx-auto text-accent-text" />
        <p className="m-0 text-sm font-semibold">{t('ai.act.emptyTitle')}</p>
        <p className="m-0 text-xs text-fg2">{t('ai.act.emptyBody')}</p>
      </div>
    );
  }
  return (
    <>
      {turns.map((turn) => (
        <section key={turn.id} className="flex flex-col gap-2.5">
          <p className="m-0 self-end rounded-2xl rounded-br-md bg-accent10 px-3 py-2 text-sm">
            {turn.request}
          </p>
          {turn.status === 'running' ? (
            <span className="flex items-center gap-1.5 text-xs text-fg2">
              <Spinner size={14} /> {t('ai.act.preparing')}
            </span>
          ) : null}
          {turn.status === 'error' ? (
            <p role="alert" className="m-0 text-xs text-danger">
              {t(`errors.${turn.error ?? 'internal'}`)}
            </p>
          ) : null}
          {turn.status === 'interrupted' ? <Interrupted onRetry={() => onRetry(turn)} /> : null}
          {turn.result ? (
            <>
              <p className="m-0 text-sm whitespace-pre-wrap">{turn.result.message}</p>
              {turn.result.proposals.length ? (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {turn.result.proposals.map((p) => (
                    <ActProposal key={p.approvalId} proposal={p} />
                  ))}
                </ul>
              ) : null}
              {turn.result.skipped.length ? (
                <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-xs text-fg2">
                  {turn.result.skipped.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              ) : null}
              {turn.result.proposals.length ? (
                <div className="flex items-center gap-2">
                  <p className="m-0 flex-1 text-[11px] text-fg3">{t('ai.act.note')}</p>
                  <ApproveAll proposals={turn.result.proposals} />
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ))}
    </>
  );
}

/** A plan of several steps is approved as a whole; each card still does its own approval. */
function ApproveAll({ proposals }: { proposals: AiActProposal[] }) {
  const { t } = useI18n();
  const details = useQueries({ queries: proposals.map((p) => approvalQuery(p.approvalId)) });
  const open = proposals.filter((_, i) => details[i]?.data?.status === 'pending');
  if (open.length < 2) return null;
  return (
    <Button
      size="xs"
      variant="pri"
      onClick={() =>
        requestDecisions(
          open.map((p) => p.approvalId),
          'approve',
        )
      }
    >
      <Icon name="check" size={13} />
      {t('ai.act.approveAll')}
    </Button>
  );
}

/** The answer with its [n] markers turned into links to the sources. */
function Cited({ text, citations }: { text: string; citations: AiCitation[] }) {
  const parts = text.split(/(\[\d+\])/g);
  const byN = new Map(citations.map((c) => [c.n, c]));
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        const c = m ? byN.get(Number(m[1])) : undefined;
        if (!c) return <Fragment key={i}>{p}</Fragment>;
        return (
          <SourceLink
            key={i}
            c={c}
            className="mx-0.5 rounded bg-bg2 px-1 text-[11px] font-semibold text-accent-text hover:bg-capsule"
          >
            {c.n}
          </SourceLink>
        );
      })}
    </>
  );
}

function Sources({ citations }: { citations: AiCitation[] }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{t('ai.ask.sources')}</span>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {citations.map((c) => (
          <li key={`${c.kind}-${c.refId}`}>
            <SourceLink
              c={c}
              className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-bg2"
            >
              <span className="mt-0.5 w-4 shrink-0 text-[11px] font-semibold text-fg3">{c.n}</span>
              <Icon name={KIND_ICON[c.kind]} size={14} className="mt-0.5 shrink-0 text-fg2" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-cap font-semibold">
                  {c.title || t(`ai.ask.kinds.${c.kind}`)}
                </span>
                {c.path ? (
                  // Live data: "Toplantı · Yarın 14:00"
                  <span className="truncate text-xs text-fg2">
                    {[t(`ai.ask.kinds.${c.kind}`), c.at ? whenLabel(c.at, locale, t) : c.snippet]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                ) : (
                  <span className="line-clamp-2 text-xs text-fg2">{c.snippet}</span>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-fg3">
                {c.path ? (
                  <span className="font-semibold text-accent-text">→ {t('ai.ask.openLink')}</span>
                ) : (
                  formatRelative(c.updatedAt, locale)
                )}
              </span>
            </SourceLink>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SourceLink({
  c,
  className,
  children,
}: {
  c: AiCitation;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const spaces = useQuery(spacesQuery());
  const href = hitLocation(c, (id) => spaces.data?.items.find((s) => s.id === id)?.slug);
  if (!href) return <span className={cn(className, 'cursor-default')}>{children}</span>;
  return (
    <a
      href={href}
      className={cn('no-underline text-inherit', className)}
      title={t('ai.ask.openSource', { title: c.title })}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        void navigate({ href });
      }}
    >
      {children}
    </a>
  );
}
