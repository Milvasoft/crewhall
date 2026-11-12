import {
  applyAssistResult,
  assistRange,
  markdownBefore,
  rangeMarkdown,
  setAssistRange,
  type AssistApplyMode,
  type AssistRange,
  type SlashItem,
} from '@crewhall/editor/react';
import {
  AI_LIMITS,
  AI_TONES,
  type AiRunRequest,
  type AiSource,
  type AiTone,
  type Locale,
} from '@crewhall/shared';
import { Button, cn, Icon, Spinner, toast, type IconName } from '@crewhall/ui';
import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AiSetupHint } from '@/components/ai/AiSetupHint';
import { useAiAvailability } from '@/lib/ai/availability';
import { useAiRun } from '@/lib/ai/useAiRun';
import { useI18n } from '@/lib/i18n/I18nContext';

type EditorAction = Exclude<AiRunRequest['action'], 'summarize_unread'>;

interface Target {
  range: AssistRange;
  /** Caret only (no selection): the panel offers "continue" alone. */
  caret: boolean;
}

/** How much text before the caret goes with "continue". */
const CONTINUE_CONTEXT = 4_000;

/**
 * AI writing help for a block editor (yol haritası #5): the selection toolbar button, the
 * "/" item "AI ile devam ettir" and the floating panel that previews the streamed answer. The
 * answer goes in only on "Değiştir / Altına ekle / Ekle", as one undoable step, and the run is
 * then recorded as accepted ("AI ile" in the audit log). The host adds `AssistHighlight` to the
 * editor's extensions so the range stays marked while the panel is open.
 */
export function useEditorAssist({
  editor,
  editable,
  source,
}: {
  editor: Editor | null;
  editable: boolean;
  source: AiSource;
}): {
  button: ReactNode;
  slashItems: () => SlashItem[];
  panel: ReactNode;
} {
  const { t } = useI18n();
  const availability = useAiAvailability();
  const [target, setTarget] = useState<Target | null>(null);
  const [autoStart, setAutoStart] = useState<EditorAction | null>(null);

  const open = useCallback((e: Editor, caretOnly = false, start: EditorAction | null = null) => {
    const { from, to, empty } = e.state.selection;
    const range = { from, to };
    if (!empty) setAssistRange(e, range);
    setAutoStart(start);
    setTarget({ range, caret: caretOnly || empty });
  }, []);

  const close = useCallback(() => {
    if (editor) setAssistRange(editor, null);
    setTarget(null);
    setAutoStart(null);
  }, [editor]);

  if (!availability.visible) {
    const button = availability.setupHint ? <AiSetupHint variant="tool" /> : null;
    return { button, slashItems: () => [], panel: null };
  }

  const button = (
    <button
      type="button"
      className="ch-tool"
      disabled={!availability.usable}
      title={availability.usable ? t('ai.menu.label') : t('ai.menu.quota')}
      aria-label={t('ai.menu.label')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor && open(editor)}
    >
      <Icon name="sparkle" size={16} /> {t('ai.menu.button')}
    </button>
  );

  const slashItems = (): SlashItem[] =>
    editable && availability.usable
      ? [
          {
            id: 'aiContinue',
            title: t('ai.menu.slashContinue'),
            description: t('ai.menu.slashContinueDesc'),
            keywords: ['ai', 'yapay', 'zeka', 'devam', 'continue', 'write', 'yaz'],
            icon: 'sparkle',
            run: (e, r) => {
              e.chain().focus().deleteRange(r).run();
              open(e, true, 'continue');
            },
          },
        ]
      : [];

  const panel =
    editor && target ? (
      <AssistPanel
        key={`${target.range.from}-${target.range.to}`}
        editor={editor}
        target={target}
        editable={editable}
        source={source}
        autoStart={autoStart}
        onClose={close}
      />
    ) : null;

  return { button, slashItems, panel };
}

const ACTION_ICON: Record<EditorAction, IconName> = {
  summarize: 'list',
  rewrite: 'pencil',
  translate: 'lang',
  continue: 'arrowR',
};

function AssistPanel({
  editor,
  target,
  editable,
  source,
  autoStart,
  onClose,
}: {
  editor: Editor;
  target: Target;
  editable: boolean;
  source: AiSource;
  autoStart: EditorAction | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { state, run, cancel, accept } = useAiRun();
  // Opened from the "/" item: "continue" starts at once.
  const [request, setRequest] = useState<AiRunRequest | null>(() =>
    autoStart === 'continue'
      ? {
          action: 'continue',
          text: markdownBefore(editor, target.range.to, CONTINUE_CONTEXT),
          source,
        }
      : null,
  );
  const [tooLong, setTooLong] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = usePanelPosition(editor, target.range);
  const action = request?.action as EditorAction | undefined;

  const start = useCallback(
    (
      req:
        | { action: 'summarize' }
        | { action: 'continue' }
        | { action: 'rewrite'; tone: AiTone }
        | { action: 'translate'; targetLang: Locale },
    ) => {
      const range = assistRange(editor) ?? target.range;
      const text =
        req.action === 'continue'
          ? markdownBefore(editor, range.to, CONTINUE_CONTEXT)
          : rangeMarkdown(editor, range.from, range.to);
      if (!text.trim()) return;
      if (text.length > AI_LIMITS.inputChars) {
        setTooLong(true);
        return;
      }
      const body = { ...req, text, source } as AiRunRequest;
      setRequest(body);
      void run(body);
    },
    [editor, target.range, source, run],
  );

  const [initial] = useState(request);
  useEffect(() => {
    if (initial && 'text' in initial && initial.text.trim()) void run(initial);
  }, [initial, run]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, onClose]);

  const apply = (mode: AssistApplyMode) => {
    const range = assistRange(editor) ?? target.range;
    const at = mode === 'continue' || target.caret ? { from: range.to, to: range.to } : range;
    if (applyAssistResult(editor, at, state.text, target.caret ? 'continue' : mode)) {
      accept();
      toast(t('ai.preview.applied'));
    }
    onClose();
  };

  const copy = async () => {
    await navigator.clipboard.writeText(state.text).catch(() => undefined);
    accept();
    toast(t('ai.preview.copied'));
  };

  const running = state.status === 'running';
  const ready = state.status === 'done' && state.text.trim().length > 0;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('ai.menu.label')}
      tabIndex={-1}
      className="fixed z-50 flex w-[min(400px,calc(100vw-32px))] flex-col gap-3 rounded-xl border border-line bg-surface p-3 shadow-overlay outline-none"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <Icon name="sparkle" size={16} className="text-accent-text" />
        <span className="flex-1 text-cap font-semibold">
          {action ? t(`ai.preview.title.${action}`) : t('ai.menu.label')}
        </span>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-md text-fg2 hover:bg-bg2"
          aria-label={t('ai.preview.close')}
          onClick={() => {
            cancel();
            onClose();
          }}
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      {!request ? (
        <ActionList caret={target.caret} editable={editable} onPick={start} tooLong={tooLong} />
      ) : (
        <>
          <div
            className="max-h-[280px] min-h-12 overflow-y-auto rounded-lg bg-bg2 px-3 py-2 text-sm whitespace-pre-wrap"
            aria-live="polite"
            aria-busy={running}
          >
            {state.text}
            {running ? (
              <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-fg3 align-middle" />
            ) : null}
          </div>
          <div className="flex min-h-5 items-center gap-1.5 text-xs text-fg2">
            {running ? (
              <>
                <Spinner size={14} /> {t('ai.preview.writing')}
              </>
            ) : state.status === 'error' ? (
              <span className="text-danger" role="alert">
                {t(`errors.${state.error ?? 'internal'}`)}
              </span>
            ) : state.truncated ? (
              t('ai.preview.truncated')
            ) : state.status === 'done' && !ready ? (
              t('ai.preview.empty')
            ) : (
              t('ai.preview.note')
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <Button size="sm" variant="out" onClick={cancel}>
                <Icon name="pause" size={14} /> {t('ai.preview.stop')}
              </Button>
            ) : (
              <>
                {ready && editable ? (
                  <ApplyButtons action={action!} caret={target.caret} onApply={apply} />
                ) : null}
                {ready ? (
                  <Button size="sm" variant={editable ? 'gh' : 'pri'} onClick={() => void copy()}>
                    <Icon name="copy" size={14} /> {t('ai.preview.copy')}
                  </Button>
                ) : null}
                <Button size="sm" variant="gh" onClick={() => void run(request)}>
                  <Icon name="refresh" size={14} /> {t('ai.preview.retry')}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="gh"
              className="ml-auto"
              onClick={() => {
                cancel();
                onClose();
              }}
            >
              {t('ai.preview.discard')}
            </Button>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

function ActionList({
  caret,
  editable,
  tooLong,
  onPick,
}: {
  caret: boolean;
  editable: boolean;
  tooLong: boolean;
  onPick: (
    req:
      | { action: 'summarize' }
      | { action: 'continue' }
      | { action: 'rewrite'; tone: AiTone }
      | { action: 'translate'; targetLang: Locale },
  ) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<'rewrite' | 'translate' | null>(null);
  const item = (a: EditorAction, onClick: () => void, expanded?: boolean) => (
    <button
      type="button"
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-cap hover:bg-bg2',
        expanded && 'bg-bg2',
      )}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Icon name={ACTION_ICON[a]} size={15} className="text-fg2" />
      <span className="flex-1">{t(`ai.menu.${a}`)}</span>
      {expanded !== undefined ? (
        <Icon name={expanded ? 'chevU' : 'chevD'} size={14} className="text-fg3" />
      ) : null}
    </button>
  );
  const chip = (label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      className="h-7 rounded-full bg-bg2 px-3 text-xs font-semibold hover:bg-capsule"
      onClick={onClick}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {tooLong ? (
        <p role="alert" className="m-0 px-2 pb-1 text-xs text-danger">
          {t('ai.menu.tooLong', { n: AI_LIMITS.inputChars })}
        </p>
      ) : null}
      {caret ? null : (
        <>
          {item('summarize', () => onPick({ action: 'summarize' }))}
          {editable
            ? item(
                'rewrite',
                () => setOpen(open === 'rewrite' ? null : 'rewrite'),
                open === 'rewrite',
              )
            : null}
          {open === 'rewrite' ? (
            <div className="flex flex-wrap gap-1.5 px-2 py-1.5">
              {AI_TONES.map((tone) =>
                chip(t(`ai.menu.tones.${tone}`), () => onPick({ action: 'rewrite', tone })),
              )}
            </div>
          ) : null}
          {item(
            'translate',
            () => setOpen(open === 'translate' ? null : 'translate'),
            open === 'translate',
          )}
          {open === 'translate' ? (
            <div className="flex flex-wrap gap-1.5 px-2 py-1.5">
              {chip(t('ai.menu.toTr'), () => onPick({ action: 'translate', targetLang: 'tr' }))}
              {chip(t('ai.menu.toEn'), () => onPick({ action: 'translate', targetLang: 'en' }))}
            </div>
          ) : null}
        </>
      )}
      {editable ? item('continue', () => onPick({ action: 'continue' })) : null}
    </div>
  );
}

function ApplyButtons({
  action,
  caret,
  onApply,
}: {
  action: EditorAction;
  caret: boolean;
  onApply: (mode: AssistApplyMode) => void;
}) {
  const { t } = useI18n();
  if (action === 'continue' || caret) {
    return (
      <Button size="sm" variant="pri" onClick={() => onApply('continue')}>
        <Icon name="check" size={14} /> {t('ai.preview.insert')}
      </Button>
    );
  }
  const replaceFirst = action !== 'summarize';
  const replace = (
    <Button
      key="replace"
      size="sm"
      variant={replaceFirst ? 'pri' : 'out'}
      onClick={() => onApply('replace')}
    >
      {replaceFirst ? <Icon name="check" size={14} /> : null} {t('ai.preview.replace')}
    </Button>
  );
  const below = (
    <Button
      key="below"
      size="sm"
      variant={replaceFirst ? 'out' : 'pri'}
      onClick={() => onApply('below')}
    >
      {replaceFirst ? null : <Icon name="check" size={14} />} {t('ai.preview.below')}
    </Button>
  );
  return <>{replaceFirst ? [replace, below] : [below, replace]}</>;
}

/** Below the range's end (above when there is no room), kept inside the window. */
function usePanelPosition(editor: Editor, range: AssistRange) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const place = () => {
      if (editor.isDestroyed) return;
      const r = assistRange(editor) ?? range;
      const size = editor.state.doc.content.size;
      let end: { top: number; bottom: number; left: number };
      let startLeft: number;
      try {
        end = editor.view.coordsAtPos(Math.min(r.to, size));
        startLeft = editor.view.coordsAtPos(Math.min(r.from, size)).left;
      } catch {
        return;
      }
      const width = Math.min(400, window.innerWidth - 32);
      const left = Math.max(16, Math.min(startLeft, window.innerWidth - width - 16));
      const below = end.bottom + 8;
      const top = below + 320 > window.innerHeight ? Math.max(16, end.top - 330) : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [editor, range]);
  return pos;
}
