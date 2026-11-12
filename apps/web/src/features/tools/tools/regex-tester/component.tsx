// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/regex-tester/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { cn } from '@/features/tools/components/ui/cn';
import { toolKey } from '@/features/tools/i18n';
import { useI18n } from '@/lib/i18n/I18nContext';
import { explainRegex, runRegex, type RegexEngine } from './logic';

const FLAGS = ['g', 'i', 'm', 's', 'u'] as const;

const EXAMPLE_TEXT =
  'Contact: ada@example.com and grace@dev.io\nOrder #1042 shipped on 2026-08-09.';

// Row meanings live in tools.items.regex-tester.cheatsheet.<section>.<row>.
const CHEATSHEET: { id: string; rows: [string, string][] }[] = [
  {
    id: 'classes',
    rows: [
      ['.', 'any'],
      ['\\w \\d \\s', 'wordDigitSpace'],
      ['\\W \\D \\S', 'notWordDigitSpace'],
      ['[abc]', 'anyOf'],
      ['[^abc]', 'noneOf'],
      ['[a-g]', 'range'],
    ],
  },
  {
    id: 'anchors',
    rows: [
      ['^abc$', 'startEnd'],
      ['\\b \\B', 'boundary'],
    ],
  },
  {
    id: 'escaped',
    rows: [
      ['\\. \\* \\\\', 'special'],
      ['\\t \\n \\r', 'whitespace'],
    ],
  },
  {
    id: 'groups',
    rows: [
      ['(abc)', 'capture'],
      ['\\1', 'backreference'],
      ['(?:abc)', 'nonCapturing'],
      ['(?=abc)', 'lookahead'],
      ['(?!abc)', 'negativeLookahead'],
    ],
  },
  {
    id: 'quantifiers',
    rows: [
      ['a* a+ a?', 'counts'],
      ['a{5} a{2,}', 'exact'],
      ['a{1,3}', 'between'],
      ['a+? a{2,}?', 'lazy'],
      ['ab|cd', 'alternation'],
    ],
  },
];

type Tab = 'replace' | 'list' | 'details' | 'explain';

export default function RegexTesterTool({ initialInput }: ToolComponentProps) {
  const { t, rich } = useI18n();
  const [pattern, setPattern] = useState('([\\w.]+)@([\\w.]+)');
  const [flags, setFlags] = useState('g');
  const [text, setText] = useState(initialInput ?? EXAMPLE_TEXT);
  const [replacement, setReplacement] = useState('$1 [at] $2');
  const [engine, setEngine] = useState<RegexEngine>('js');
  const [tab, setTab] = useState<Tab>('list');
  const [showCheatsheet, setShowCheatsheet] = useState(true);

  const result = useMemo(
    () => runRegex(pattern, flags, text, tab === 'replace' ? replacement : undefined, engine),
    [pattern, flags, text, replacement, tab, engine],
  );

  const explanation = useMemo(() => explainRegex(pattern), [pattern]);

  const toggleFlag = (flag: string) =>
    setFlags((f) => (f.includes(flag) ? f.replace(flag, '') : f + flag));

  const highlighted = useMemo(() => {
    if (result.error || result.matches.length === 0) return null;
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    result.matches.forEach((m, i) => {
      if (m.index > cursor) nodes.push(text.slice(cursor, m.index));
      nodes.push(
        <mark
          key={i}
          className="rounded bg-[color-mix(in_srgb,var(--accent)_28%,transparent)] text-fg"
        >
          {m.match || '∅'}
        </mark>,
      );
      cursor = m.index + m.match.length;
    });
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
  }, [result, text]);

  const TABS: Tab[] = ['replace', 'list', 'details', 'explain'];

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4',
        showCheatsheet ? 'lg:grid-cols-[240px_1fr]' : 'lg:grid-cols-1',
      )}
    >
      {/* Cheatsheet */}
      {showCheatsheet && (
        <aside className="self-start overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-fg2">
              {t('tools.items.regex-tester.cheatsheetTitle')}
            </span>
            <button
              onClick={() => setShowCheatsheet(false)}
              className="text-fg3 hover:text-fg"
              aria-label={t('tools.items.regex-tester.hideCheatsheet')}
            >
              ×
            </button>
          </div>
          <div className="max-h-[70vh] overflow-auto px-3 py-2">
            {CHEATSHEET.map((section) => (
              <div key={section.id} className="mb-3 last:mb-0">
                <div className="mb-1 text-[11px] font-semibold text-accent-text">
                  {t(toolKey('regex-tester', `cheatsheet.${section.id}.title`))}
                </div>
                {section.rows.map(([token, meaning]) => (
                  <button
                    key={token}
                    onClick={() => setPattern((p) => p + token.split(' ')[0])}
                    className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-bg2"
                    title={t('tools.items.regex-tester.appendToPattern')}
                  >
                    <code className="shrink-0 font-mono text-[11px] text-fg">{token}</code>
                    <span className="text-[11px] text-fg3">
                      {t(toolKey('regex-tester', `cheatsheet.${section.id}.${meaning}`))}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {!showCheatsheet && (
            <button
              onClick={() => setShowCheatsheet(true)}
              className="h-9 rounded-md border border-line bg-surface px-2.5 text-xs text-fg2 hover:bg-bg2"
            >
              {t('tools.items.regex-tester.cheatsheetTitle')}
            </button>
          )}
          <div className="flex min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border border-line bg-surface font-mono text-sm">
            <span className="flex items-center border-r border-line bg-bg2 px-2 text-fg3">/</span>
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              spellCheck={false}
              placeholder={t('tools.items.regex-tester.patternPlaceholder')}
              aria-label={t('tools.items.regex-tester.patternLabel')}
              className="min-w-0 flex-1 bg-transparent px-2 py-2 text-fg outline-none"
            />
            <span className="flex items-center border-l border-line bg-bg2 px-2 text-fg3">
              /{flags}
            </span>
          </div>
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as RegexEngine)}
            className="h-9 rounded-md border border-line bg-surface px-2 text-xs outline-none"
            aria-label={t('tools.items.regex-tester.engine')}
          >
            <option value="js">JavaScript</option>
            <option value="dotnet">{t('tools.items.regex-tester.dotnetApprox')}</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {FLAGS.map((f) => (
            <label
              key={f}
              className="flex items-center gap-1 text-xs text-fg2"
              title={t(`tools.items.regex-tester.flags.${f}`)}
            >
              <input type="checkbox" checked={flags.includes(f)} onChange={() => toggleFlag(f)} />
              <span className="font-mono">{f}</span>
            </label>
          ))}
          <span className="ml-auto text-xs text-fg3">
            {result.error ? (
              <span className="text-danger">{result.error}</span>
            ) : (
              t('tools.items.regex-tester.matchCount', { count: result.matches.length })
            )}
          </span>
        </div>

        <ToolEditor
          label={t('tools.items.regex-tester.testString')}
          value={text}
          onChange={setText}
          minRows={7}
        />

        {/* Highlighted preview */}
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="border-b border-line bg-bg2 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fg2">
            {t('tools.items.regex-tester.matchPreview')}
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-sm text-fg">
            {result.error ? (
              <span className="text-danger">{result.error}</span>
            ) : highlighted ? (
              highlighted
            ) : (
              <span className="text-fg3">{t('tools.items.regex-tester.noMatches')}</span>
            )}
          </pre>
        </div>

        {/* Tools tabs */}
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex border-b border-line bg-bg2">
            {TABS.map((id) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  'h-9 px-4 text-sm font-medium transition-colors',
                  tab === id ? 'border-b-2 border-accent text-fg' : 'text-fg2 hover:text-fg',
                )}
              >
                {t(`tools.items.regex-tester.tabs.${id}`)}
              </button>
            ))}
          </div>

          <div className="max-h-[50vh] overflow-auto p-3">
            {tab === 'replace' && (
              <div className="flex flex-col gap-2">
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder={t('tools.items.regex-tester.replacement')}
                  aria-label={t('tools.items.regex-tester.replacement')}
                  className="h-9 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg outline-none focus:border-accent"
                />
                <p className="text-[11px] text-fg3">
                  {rich('tools.items.regex-tester.replaceHelp', {
                    group: () => <code className="font-mono">$1</code>,
                    named: () => <code className="font-mono">$&lt;name&gt;</code>,
                    dollar: () => <code className="font-mono">$$</code>,
                  })}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-fg2">
                    {t('tools.common.result')}
                  </span>
                  <CopyButton size="sm" variant="ghost" value={result.replacement ?? ''} />
                </div>
                <pre className="whitespace-pre-wrap break-words rounded bg-bg2 px-3 py-2 font-mono text-sm text-fg">
                  {result.replacement ?? ''}
                </pre>
              </div>
            )}

            {tab === 'list' &&
              (result.matches.length === 0 ? (
                <p className="text-sm text-fg3">{t('tools.items.regex-tester.noMatches')}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-fg3">
                      {t('tools.items.regex-tester.matchCount', { count: result.matches.length })}
                    </span>
                    <CopyButton
                      size="sm"
                      variant="ghost"
                      value={result.matches.map((m) => m.match).join('\n')}
                      label={t('tools.items.regex-tester.copyAll')}
                    />
                  </div>
                  {result.matches.slice(0, 500).map((m, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between border-b border-line/50 py-1 font-mono text-xs last:border-0"
                    >
                      <span className="text-fg">{m.match || '∅'}</span>
                      <span className="text-fg3">@ {m.index}</span>
                    </div>
                  ))}
                </div>
              ))}

            {tab === 'details' &&
              (result.matches.length === 0 ? (
                <p className="text-sm text-fg3">{t('tools.items.regex-tester.noMatches')}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {result.matches.slice(0, 200).map((m, i) => (
                    <div key={i} className="rounded border border-line/60 p-2 text-xs">
                      <div className="mb-1 flex items-center justify-between font-mono">
                        <span className="text-fg">
                          {t('tools.items.regex-tester.matchN', { n: i + 1 })}: {m.match || '∅'}
                        </span>
                        <span className="text-fg3">
                          [{m.index}–{m.index + m.match.length}]
                        </span>
                      </div>
                      {m.groups.length === 0 && Object.keys(m.namedGroups).length === 0 ? (
                        <p className="text-fg3">{t('tools.items.regex-tester.noGroups')}</p>
                      ) : (
                        <div className="space-y-0.5 font-mono text-fg2">
                          {m.groups.map((g, gi) => (
                            <div key={gi}>
                              <span className="text-[var(--syntax-key)]">${gi + 1}</span>:{' '}
                              {g || '∅'}
                            </div>
                          ))}
                          {Object.entries(m.namedGroups).map(([k, v]) => (
                            <div key={k}>
                              <span className="text-[var(--syntax-key)]">
                                ${'<'}
                                {k}
                                {'>'}
                              </span>
                              : {v || '∅'}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}

            {tab === 'explain' &&
              (explanation.length === 0 ? (
                <p className="text-sm text-fg3">{t('tools.items.regex-tester.explainEmpty')}</p>
              ) : (
                <div className="flex flex-col">
                  {explanation.map((tok, i) => (
                    <div
                      key={i}
                      className="flex items-baseline gap-3 border-b border-line/50 py-1.5 last:border-0"
                    >
                      <code className="shrink-0 rounded bg-bg2 px-1.5 py-0.5 font-mono text-xs text-fg">
                        {tok.token}
                      </code>
                      <span className="text-sm text-fg2">{tok.description}</span>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
