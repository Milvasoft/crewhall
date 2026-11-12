// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/http-mime/component.tsx. See THIRD_PARTY.md.
import { useCallback, useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { filterMimes, filterStatuses, HTTP_STATUSES, type HttpStatus } from './logic';

type Tab = 'http' | 'mime';

export default function HttpMimeTool(_props: ToolComponentProps) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>('http');
  const [query, setQuery] = useState('');

  // Descriptions are translated per code; the English text in logic.ts is the fallback.
  const describe = useCallback(
    (s: HttpStatus): string => {
      const key = `tools.items.http-mime.statuses.${s.code}` as MessageKey;
      const text = t(key);
      return text === key ? s.description : text;
    },
    [t],
  );

  // Match the English reference (logic.ts) and the translated description.
  const statuses = useMemo(() => {
    const q = query.trim().toLocaleLowerCase(locale);
    const matched = new Set(filterStatuses(query).map((s) => s.code));
    return HTTP_STATUSES.filter(
      (s) => matched.has(s.code) || (q && describe(s).toLocaleLowerCase(locale).includes(q)),
    );
  }, [query, locale, describe]);
  const mimes = useMemo(() => filterMimes(query), [query]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['http', 'mime'] as Tab[]).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                tab === id ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {id === 'http'
                ? t('tools.items.http-mime.tabHttp')
                : t('tools.items.http-mime.tabMime')}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            tab === 'http'
              ? t('tools.items.http-mime.searchHttp')
              : t('tools.items.http-mime.searchMime')
          }
          aria-label={t('tools.items.http-mime.search')}
          className="h-8 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {tab === 'http'
          ? statuses.map((s) => (
              <div
                key={s.code}
                className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
              >
                <span className="w-10 shrink-0 font-mono text-sm font-semibold text-accent-text">
                  {s.code}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-fg">{s.message}</span>
                  <span className="ml-2 text-xs text-fg3">{describe(s)}</span>
                </div>
                <CopyButton
                  size="sm"
                  variant="ghost"
                  value={`${s.code} ${s.message}`}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
            ))
          : mimes.map((m) => (
              <div
                key={m.ext + m.type}
                className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
              >
                <span className="w-16 shrink-0 font-mono text-sm text-fg2">.{m.ext}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{m.type}</span>
                <CopyButton
                  size="sm"
                  variant="ghost"
                  value={m.type}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
            ))}
        {tab === 'http' && statuses.length === 0 && (
          <div className="px-3 py-3 text-sm text-fg3">{t('tools.items.http-mime.noMatches')}</div>
        )}
        {tab === 'mime' && mimes.length === 0 && (
          <div className="px-3 py-3 text-sm text-fg3">{t('tools.items.http-mime.noMatches')}</div>
        )}
      </div>
    </div>
  );
}
