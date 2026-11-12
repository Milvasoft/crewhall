// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-parser/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { parsedToJson, parseUrl } from './logic';

const FIELDS = [
  'protocol',
  'username',
  'password',
  'hostname',
  'port',
  'origin',
  'pathname',
  'hash',
] as const;

export default function UrlParserTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(
    initialInput ?? 'https://user@example.com:8080/path/to?page=2&sort=asc#section',
  );
  const definition = getDefinition('url-parser')!;

  const { parsed, json, error } = useMemo(() => {
    if (!input.trim()) {
      return { parsed: null, json: '', error: false };
    }
    try {
      const p = parseUrl(input);
      return { parsed: p, json: parsedToJson(p), error: false };
    } catch {
      // The URL constructor only throws for an unparsable URL.
      return { parsed: null, json: '', error: true };
    }
  }, [input]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder="https://example.com/path?query=value"
          aria-label="URL"
          className="h-11 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg outline-none focus:border-accent"
        />
        {parsed && <SendToMenu source={definition} value={json} />}
      </div>

      {error && <p className="text-sm text-danger">{t('tools.items.url-parser.invalid')}</p>}

      {parsed && (
        <SplitGrid
          leftLabel={t('tools.items.url-parser.components')}
          rightLabel={t('tools.items.url-parser.details')}
        >
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
              {t('tools.items.url-parser.components')}
            </div>
            {FIELDS.map((f) => (
              <div
                key={f}
                className="flex items-center gap-3 border-b border-line/60 px-3 py-1.5 text-sm last:border-0"
              >
                <span className="w-24 shrink-0 text-xs text-fg3">
                  {t(`tools.items.url-parser.fields.${f}`)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-fg">
                  {String(parsed[f]) || '—'}
                </span>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fg2">
              <span>
                {t('tools.items.url-parser.queryParams', { count: parsed.params.length })}
              </span>
            </div>
            {parsed.params.length ? (
              parsed.params.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 border-b border-line/60 px-3 py-1.5 text-sm last:border-0"
                >
                  <span className="min-w-0 max-w-[40%] truncate font-mono text-[var(--syntax-key)]">
                    {p.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-fg">{p.value}</span>
                </div>
              ))
            ) : (
              <div className="px-3 py-2 text-xs text-fg3">
                {t('tools.items.url-parser.noParams')}
              </div>
            )}
          </div>
        </SplitGrid>
      )}

      {parsed && (
        <div className="flex justify-end">
          <CopyButton
            size="sm"
            variant="secondary"
            value={json}
            label={t('tools.items.url-parser.copyJson')}
          />
        </div>
      )}
    </div>
  );
}
