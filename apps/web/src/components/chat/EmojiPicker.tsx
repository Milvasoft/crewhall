import { cn, Input, Popover, PopoverContent, PopoverTrigger, Spinner } from '@crewhall/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * The emoji picker for messages, reactions, channel emoji and status: the full Unicode set
 * (emojibase-data, MIT) with English and Turkish keywords (Unicode CLDR), categories, recent
 * picks and a skin tone. The data (~330 KB) loads the first time a picker opens.
 */

interface EmojiEntry {
  /** The emoji. */
  e: string;
  /** emojibase group: 0 smileys … 9 flags (2, components, is left out). */
  g: number;
  /** Turkish name (CLDR) and English label. */
  n: string;
  l: string;
  /** Lower-case keywords in both languages. */
  k: string;
  /** Skin tone variants, light to dark. */
  s?: string[];
}

/** Shown first and in "recent" until the person has picks of their own. */
export const DEFAULT_QUICK = ['👍', '❤️', '😂', '🎉', '🙏'];
const DEFAULT_RECENT = [
  ...DEFAULT_QUICK,
  '🚀',
  '👀',
  '👏',
  '🔥',
  '✅',
  '😊',
  '🤔',
  '😮',
  '😢',
  '💯',
  '👋',
];

const GROUPS = [0, 1, 3, 4, 5, 6, 7, 8, 9] as const;
type GroupKey = (typeof GROUPS)[number] | 'recent';
const GROUP_ICON: Record<GroupKey, string> = {
  recent: '🕘',
  0: '😀',
  1: '👋',
  3: '🐻',
  4: '🍔',
  5: '✈️',
  6: '⚽',
  7: '💡',
  8: '❤️',
  9: '🏁',
};
const TONES = ['', '🏻', '🏼', '🏽', '🏾', '🏿'] as const;
const TONE_KEYS = [0, 1, 2, 3, 4, 5] as const;
const RECENT_KEY = 'crewhall.emoji.recent';
const TONE_KEY = 'crewhall.emoji.tone';
const RECENT_MAX = 24;

let data: Promise<EmojiEntry[]> | null = null;
function loadEmojis(): Promise<EmojiEntry[]> {
  data ??= import('@/lib/emoji/emoji-data.json').then(
    (m) => (m as unknown as { default: EmojiEntry[] }).default,
  );
  return data;
}

function useEmojis(open: boolean) {
  const [list, setList] = useState<EmojiEntry[] | null>(null);
  useEffect(() => {
    if (!open || list) return;
    let live = true;
    void loadEmojis().then((d) => live && setList(d));
    return () => {
      live = false;
    };
  }, [open, list]);
  return list;
}

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function readTone(): number {
  try {
    const n = Number(localStorage.getItem(TONE_KEY) ?? 0);
    return Number.isInteger(n) && n >= 0 && n < TONES.length ? n : 0;
  } catch {
    return 0;
  }
}

function remember(emoji: string) {
  try {
    const next = [emoji, ...readList(RECENT_KEY).filter((x) => x !== emoji)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode: recents just do not stick.
  }
}

/** The variant for the chosen tone, when the emoji has tones. */
const withTone = (x: EmojiEntry, tone: number) => (tone && x.s?.[tone - 1]) || x.e;

export function EmojiPicker({
  onPick,
  children,
  align = 'end',
}: {
  onPick: (emoji: string) => void;
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<GroupKey>('recent');
  const [tone, setTone] = useState(readTone);
  const list = useEmojis(open);
  const byEmoji = useMemo(() => new Map((list ?? []).map((x) => [x.e, x])), [list]);

  const shown = useMemo(() => {
    if (!list) return [];
    const query = q.trim().toLocaleLowerCase(locale);
    if (query) {
      const words = query.split(/\s+/);
      return list.filter((x) => words.every((w) => x.k.includes(w))).slice(0, 160);
    }
    if (group === 'recent') {
      const recent = readList(RECENT_KEY);
      const picks = [...recent, ...DEFAULT_RECENT.filter((e) => !recent.includes(e))];
      return picks.map((e) => byEmoji.get(e) ?? { e, g: 0, n: e, l: e, k: '' });
    }
    return list.filter((x) => x.g === group);
  }, [list, q, group, byEmoji, locale]);

  const pick = (emoji: string) => {
    remember(emoji);
    onPick(emoji);
    setOpen(false);
    setQ('');
  };

  const chooseTone = (i: number) => {
    setTone(i);
    try {
      localStorage.setItem(TONE_KEY, String(i));
    } catch {
      // ignore
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        className="flex w-[336px] flex-col gap-2 p-2"
        aria-label={t('chat.reactions.picker')}
      >
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('chat.emojiPicker.search')}
            aria-label={t('chat.emojiPicker.search')}
            containerClassName="h-8 min-w-0 flex-1 px-2.5"
          />
          <div className="flex" role="radiogroup" aria-label={t('chat.emojiPicker.tone')}>
            {TONE_KEYS.map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={tone === i}
                aria-label={t(`chat.emojiPicker.tones.${i}`)}
                onClick={() => chooseTone(i)}
                className={cn(
                  'flex size-[22px] items-center justify-center rounded text-[13px]',
                  tone === i && 'bg-bg2 shadow-line',
                )}
              >
                {`👋${TONES[i]}`}
              </button>
            ))}
          </div>
        </div>
        {!q.trim() ? (
          <div
            className="flex justify-between"
            role="tablist"
            aria-label={t('chat.emojiPicker.groups')}
          >
            {(['recent', ...GROUPS] as GroupKey[]).map((g) => (
              <button
                key={g}
                type="button"
                role="tab"
                aria-selected={group === g}
                aria-label={t(`chat.emojiPicker.group.${g}`)}
                onClick={() => setGroup(g)}
                className={cn(
                  'flex size-8 items-center justify-center rounded-md text-[17px] transition-opacity',
                  group === g ? 'bg-bg2' : 'opacity-60 hover:opacity-100',
                )}
              >
                {GROUP_ICON[g]}
              </button>
            ))}
          </div>
        ) : null}
        <div className="h-[240px] overflow-y-auto overscroll-contain">
          {!list ? (
            <div className="flex justify-center p-6">
              <Spinner size={18} />
            </div>
          ) : shown.length === 0 ? (
            <p className="m-0 p-4 text-center text-cap text-fg2">{t('chat.emojiPicker.empty')}</p>
          ) : (
            <div
              className="grid grid-cols-8 gap-0.5"
              role="listbox"
              aria-label={t('chat.reactions.picker')}
            >
              {shown.map((x) => {
                const emoji = withTone(x, tone);
                return (
                  <button
                    key={x.e}
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-label={emoji}
                    title={locale === 'tr' ? x.n : x.l}
                    onClick={() => pick(emoji)}
                    className="flex size-9 items-center justify-center rounded-md text-[20px] hover:bg-bg2"
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
