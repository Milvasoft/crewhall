// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/emoji-picker/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { useI18n } from '@/lib/i18n/I18nContext';
import { EMOJI_GROUPS, searchEmojis, type EmojiEntry } from './logic';

const LIMIT = 300;

// The dataset's group names are English; map them to dictionary keys for display.
const GROUP_KEYS = {
  'Smileys & Emotion': 'smileys',
  'People & Body': 'people',
  'Animals & Nature': 'animals',
  'Food & Drink': 'food',
  'Travel & Places': 'travel',
  Activities: 'activities',
  Objects: 'objects',
  Symbols: 'symbols',
  Flags: 'flags',
  Other: 'other',
} as const;
type GroupKey = (typeof GROUP_KEYS)[keyof typeof GROUP_KEYS];
const groupKey = (group: string): GroupKey | undefined =>
  (GROUP_KEYS as Record<string, GroupKey | undefined>)[group];

export default function EmojiPickerTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('All');
  const [copied, setCopied] = useState<string | null>(null);

  const results = useMemo(() => searchEmojis(query, group), [query, group]);
  const shown = results.slice(0, LIMIT);

  const copy = async (e: EmojiEntry) => {
    try {
      await navigator.clipboard.writeText(e.char);
      setCopied(e.char);
      setTimeout(() => setCopied((c) => (c === e.char ? null : c)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const groupLabel = (g: string) => {
    const key = groupKey(g);
    return key ? t(`tools.items.emoji-picker.groups.${key}`) : g;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('tools.items.emoji-picker.searchPlaceholder')}
          spellCheck={false}
          className="h-10 w-full max-w-sm rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
        />
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="h-10 rounded-lg border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
        >
          <option value="All">{t('tools.items.emoji-picker.allGroups')}</option>
          {EMOJI_GROUPS.map((g) => (
            <option key={g} value={g}>
              {groupLabel(g)}
            </option>
          ))}
        </select>
        <span className="text-xs text-fg3">
          {t('tools.items.emoji-picker.matches', { count: results.length })}
          {results.length > LIMIT ? t('tools.items.emoji-picker.showing', { limit: LIMIT }) : ''}
        </span>
      </div>

      {copied && (
        <div className="text-sm text-success">
          {t('tools.items.emoji-picker.copiedChar', { value: copied })}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1">
        {shown.map((e) => (
          <button
            key={e.char}
            onClick={() => copy(e)}
            title={e.name}
            className="flex h-12 items-center justify-center rounded-md border border-transparent text-2xl transition-colors hover:border-line hover:bg-bg2"
          >
            {e.char}
          </button>
        ))}
      </div>

      {results.length === 0 && (
        <p className="text-sm text-fg2">{t('tools.items.emoji-picker.noMatch', { q: query })}</p>
      )}
    </div>
  );
}
