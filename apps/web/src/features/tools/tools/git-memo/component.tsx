// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/git-memo/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { toolKey } from '@/features/tools/i18n';
import { useI18n } from '@/lib/i18n/I18nContext';
import { GIT_MEMO, filterGitMemo } from './logic';

export default function GitMemoTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  // Search runs over the texts in the current language.
  const localized = useMemo(
    () =>
      GIT_MEMO.map((group) => ({
        ...group,
        name: t(toolKey('git-memo', `groups.${group.id}`)),
        commands: group.commands.map((c) => ({
          ...c,
          description: t(toolKey('git-memo', `commands.${c.id}`)),
        })),
      })),
    [t],
  );
  const groups = useMemo(() => filterGitMemo(query, localized), [query, localized]);

  return (
    <div className="max-w-3xl space-y-4">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('tools.items.git-memo.searchPlaceholder')}
        spellCheck={false}
        className="h-10 w-full max-w-md rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
      />

      {groups.length === 0 ? (
        <p className="text-sm text-fg2">{t('tools.items.git-memo.noMatches', { q: query })}</p>
      ) : (
        groups.map((group) => (
          <div key={group.id} className="space-y-1.5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-fg3">{group.name}</h2>
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {group.commands.map((c) => (
                <div
                  key={c.command}
                  className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
                >
                  <code className="min-w-0 shrink-0 font-mono text-sm text-accent-text">
                    {c.command}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg2">{c.description}</span>
                  <CopyButton
                    size="sm"
                    variant="ghost"
                    value={c.command}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
