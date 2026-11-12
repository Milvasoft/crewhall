import { Dialog, DialogContent, DialogHeader, Kbd } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { uiPrefsQuery } from '@/lib/shell/navOrder';
import {
  CHORD_MS,
  comboLabel,
  isMac,
  ownsKeys,
  setKeyboardHelpOpen,
  shortcutOf,
  useKeyboardHelpOpen,
} from '@/lib/shell/shortcuts';
import { useRailEntries } from './Rail';

const overlayOpen = () => Boolean(document.querySelector('[role="dialog"],[role="menu"]'));

/**
 * The app's global keys: a rail entry's shortcut (G then a key, or Alt Shift plus a key; see
 * lib/shell/shortcuts) and ? for the list of keys. Quiet while the person types or a dialog is
 * open. Hidden rail entries keep their shortcut: hiding is about the menu's room.
 */
function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  const { modules, extra } = useRailEntries({ includeHidden: true });
  const { data: prefs } = useQuery(uiPrefsQuery);
  const targets = useMemo(() => {
    const out = new Map<string, string>();
    for (const e of [...modules, ...extra]) {
      const combo = shortcutOf(e.id, prefs?.railShortcuts);
      if (combo && !out.has(combo)) out.set(combo, e.to);
    }
    return out;
  }, [modules, extra, prefs?.railShortcuts]);
  const chordUntil = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented || ownsKeys(e.target) || overlayOpen()) return;
      if (e.ctrlKey || e.metaKey) return;
      const go = (combo: string) => {
        const to = targets.get(combo);
        if (!to) return false;
        e.preventDefault();
        e.stopPropagation();
        void navigate({ to });
        return true;
      };
      if (e.altKey && e.shiftKey) {
        const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code);
        if (m) go(`alt+shift+${(m[1] ?? m[2]!).toLowerCase()}`);
        return;
      }
      if (e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        setKeyboardHelpOpen(true);
        return;
      }
      if (e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (Date.now() < chordUntil.current) {
        chordUntil.current = 0;
        // The second key is the chord's, not the page's (I on Drive, J in mail).
        e.stopPropagation();
        go(`g ${key}`);
        return;
      }
      if (key === 'g') chordUntil.current = Date.now() + CHORD_MS;
    };
    // Capture: a chord's second key must not also reach the page's own shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate, targets]);
}

/** Shortcuts the app already answers to, by the area that owns them. */
const GROUPS: { title: MessageKey; rows: { keys: string[]; label: MessageKey }[] }[] = [
  {
    title: 'shell.keys.general',
    rows: [
      { keys: ['Mod', 'K'], label: 'shell.keys.palette' },
      { keys: ['Mod', 'J'], label: 'shell.keys.ask' },
      { keys: ['Alt', 'S'], label: 'shell.keys.status' },
      { keys: ['?'], label: 'shell.keys.help' },
    ],
  },
  {
    title: 'shell.keys.lists',
    rows: [
      { keys: ['Mod', 'A'], label: 'shell.keys.selectAll' },
      { keys: ['Esc'], label: 'shell.keys.clear' },
    ],
  },
  {
    title: 'shell.keys.drive',
    rows: [
      { keys: ['Space'], label: 'shell.keys.preview' },
      { keys: ['F2'], label: 'shell.keys.rename' },
      { keys: ['Del'], label: 'shell.keys.trash' },
      { keys: ['I'], label: 'shell.keys.details' },
      { keys: ['K'], label: 'shell.keys.newFolder' },
      { keys: ['U'], label: 'shell.keys.upload' },
    ],
  },
  {
    title: 'shell.keys.chat',
    rows: [
      { keys: ['Mod', 'E'], label: 'shell.keys.chatSearch' },
      { keys: ['R'], label: 'shell.keys.reply' },
      { keys: ['E'], label: 'shell.keys.edit' },
      { keys: ['U'], label: 'shell.keys.unread' },
    ],
  },
  {
    title: 'shell.keys.mail',
    rows: [
      { keys: ['J'], label: 'shell.keys.next' },
      { keys: ['K'], label: 'shell.keys.previous' },
    ],
  },
  {
    title: 'shell.keys.vault',
    rows: [
      { keys: ['/'], label: 'shell.keys.search' },
      { keys: ['N'], label: 'shell.keys.newItem' },
      { keys: ['Mod', 'L'], label: 'shell.keys.lock' },
    ],
  },
];

function Keys({ keys }: { keys: string[] }) {
  const mod = isMac() ? '⌘' : 'Ctrl';
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <Kbd key={i}>{k === 'Mod' ? mod : k}</Kbd>
      ))}
    </span>
  );
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="min-w-0 truncate">{label}</span>
      <Keys keys={keys} />
    </li>
  );
}

/** The app's global keys and their list, opened with ? or from the account menu. */
export function KeyboardShortcuts() {
  const { t } = useI18n();
  useGlobalShortcuts();
  const open = useKeyboardHelpOpen();
  const { modules, extra } = useRailEntries({ includeHidden: true });
  const { data: prefs } = useQuery(uiPrefsQuery);
  const rail = [...modules, ...extra]
    .map((e) => ({
      id: e.id,
      label: e.label,
      keys: comboLabel(shortcutOf(e.id, prefs?.railShortcuts)),
    }))
    .filter((e) => e.keys.length);
  return (
    <Dialog open={open} onOpenChange={setKeyboardHelpOpen}>
      <DialogContent width={720}>
        <DialogHeader
          icon="key"
          title={t('shell.keys.title')}
          description={t('shell.keys.subtitle')}
        />
        <div className="grid max-h-[60vh] grid-cols-2 gap-x-8 gap-y-4 overflow-y-auto max-md:grid-cols-1">
          <section>
            <h3 className="eyebrow m-0 pb-1">{t('shell.keys.navigation')}</h3>
            <ul className="m-0 list-none p-0">
              {rail.map((e) => (
                <Row key={e.id} keys={e.keys} label={e.label} />
              ))}
            </ul>
          </section>
          <div className="flex flex-col gap-4">
            {GROUPS.map((g) => (
              <section key={g.title}>
                <h3 className="eyebrow m-0 pb-1">{t(g.title)}</h3>
                <ul className="m-0 list-none p-0">
                  {g.rows.map((r) => (
                    <Row key={r.label} keys={r.keys} label={t(r.label)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
