// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-viewer/JsonTree.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Collapsible JSON tree with copy-path / copy-value and search.
 *
 * Pure presentational state (which nodes are expanded) lives here; it never
 * mutates or persists the data. Search filters to branches that contain a match
 * and auto-expands them.
 */

type Json = unknown;

const IDENT = /^[A-Za-z_$][\w$]*$/;

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function kind(v: Json): 'object' | 'array' | 'primitive' {
  if (Array.isArray(v)) return 'array';
  if (v !== null && typeof v === 'object') return 'object';
  return 'primitive';
}

function primitivePreview(v: Json): { text: string; className: string } {
  if (v === null) return { text: 'null', className: 'text-[var(--syntax-atom)]' };
  switch (typeof v) {
    case 'string':
      return { text: `"${v}"`, className: 'text-[var(--syntax-string)]' };
    case 'number':
      return { text: String(v), className: 'text-[var(--syntax-number)]' };
    case 'boolean':
      return { text: String(v), className: 'text-[var(--syntax-atom)]' };
    default:
      return { text: String(v), className: 'text-fg' };
  }
}

function matchesQuery(key: string, value: Json, q: string): boolean {
  if (!q) return true;
  if (key.toLowerCase().includes(q)) return true;
  const k = kind(value);
  if (k === 'primitive') return String(value).toLowerCase().includes(q);
  return false;
}

function subtreeMatches(key: string, value: Json, q: string): boolean {
  if (!q) return true;
  if (matchesQuery(key, value, q)) return true;
  const k = kind(value);
  if (k === 'array') {
    return (value as Json[]).some((v, i) => subtreeMatches(String(i), v, q));
  }
  if (k === 'object') {
    return Object.entries(value as Record<string, Json>).some(([ck, cv]) =>
      subtreeMatches(ck, cv, q),
    );
  }
  return false;
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-[color-mix(in_srgb,var(--accent)_28%,transparent)] text-fg">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

interface RowProps {
  label: string; // key or index as string
  value: Json;
  path: string;
  depth: number;
  expandedSet: Set<string>;
  toggle: (path: string) => void;
  query: string;
}

function Node({ label, value, path, depth, expandedSet, toggle, query }: RowProps) {
  const { t } = useI18n();
  const k = kind(value);
  const q = query.toLowerCase();

  if (query && !subtreeMatches(label, value, q)) return null;

  const open = query ? true : expandedSet.has(path) || depth === 0;
  const entries: [string, Json][] =
    k === 'array'
      ? (value as Json[]).map((v, i) => [String(i), v])
      : k === 'object'
        ? Object.entries(value as Record<string, Json>)
        : [];

  const count = entries.length;
  const summary = k === 'array' ? `[${count}]` : k === 'object' ? `{${count}}` : '';

  return (
    <div>
      <div
        className="group flex items-start gap-1 rounded px-1 hover:bg-bg2"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {k !== 'primitive' ? (
          <button
            onClick={() => toggle(path)}
            className="mt-0.5 h-4 w-4 shrink-0 select-none text-fg3 hover:text-fg"
            aria-label={open ? t('tools.common.collapse') : t('tools.common.expand')}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}

        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5">
          {depth > 0 && (
            <span className="text-[var(--syntax-key)]">
              <Highlight text={label} q={q} />
              {': '}
            </span>
          )}
          {k === 'primitive' ? (
            (() => {
              const p = primitivePreview(value);
              return (
                <span className={p.className}>
                  {typeof value === 'string' ? (
                    <>
                      &quot;
                      <Highlight text={String(value)} q={q} />
                      &quot;
                    </>
                  ) : (
                    <Highlight text={p.text} q={q} />
                  )}
                </span>
              );
            })()
          ) : (
            <span className="text-fg3">{summary}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => navigator.clipboard.writeText(path)}
            className="rounded px-1 text-[10px] text-fg3 hover:bg-surface hover:text-fg"
            title={t('tools.items.json-viewer.copyPath', { path })}
          >
            {t('tools.items.json-viewer.pathButton')}
          </button>
          <button
            onClick={() =>
              navigator.clipboard.writeText(
                k === 'primitive' ? String(value) : JSON.stringify(value, null, 2),
              )
            }
            className="rounded px-1 text-[10px] text-fg3 hover:bg-surface hover:text-fg"
            title={t('tools.items.json-viewer.copyValue')}
          >
            {t('tools.items.json-viewer.valueButton')}
          </button>
        </div>
      </div>

      {k !== 'primitive' && open && (
        <div>
          {entries.map(([ck, cv]) => (
            <Node
              key={ck}
              label={ck}
              value={cv}
              path={childPath(path, k === 'array' ? Number(ck) : ck)}
              depth={depth + 1}
              expandedSet={expandedSet}
              toggle={toggle}
              query={query}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function JsonTree({ value }: { value: Json }) {
  const { t } = useI18n();
  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set(['$']));
  const [query, setQuery] = useState('');

  const toggle = (path: string) =>
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // Expand/collapse-all helpers.
  const allPaths = useMemo(() => collectPaths(value, '$'), [value]);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg2 px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg2">
          {t('tools.items.json-viewer.tree')}
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('tools.items.json-viewer.searchPlaceholder')}
          aria-label={t('tools.items.json-viewer.searchLabel')}
          className="ml-auto h-6 w-48 rounded border border-line bg-surface px-2 text-xs text-fg outline-none focus:border-accent"
        />
        <button
          onClick={() => setExpandedSet(new Set(allPaths))}
          className="rounded px-1.5 py-0.5 text-[11px] text-fg2 hover:bg-surface hover:text-fg"
        >
          {t('tools.items.json-viewer.expandAll')}
        </button>
        <button
          onClick={() => setExpandedSet(new Set(['$']))}
          className="rounded px-1.5 py-0.5 text-[11px] text-fg2 hover:bg-surface hover:text-fg"
        >
          {t('tools.common.collapse')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-2">
        <Node
          label="$"
          value={value}
          path="$"
          depth={0}
          expandedSet={expandedSet}
          toggle={toggle}
          query={query}
        />
      </div>
    </div>
  );
}

function collectPaths(value: Json, path: string, acc: string[] = []): string[] {
  acc.push(path);
  const k = kind(value);
  if (k === 'array') {
    (value as Json[]).forEach((v, i) => collectPaths(v, childPath(path, i), acc));
  } else if (k === 'object') {
    Object.entries(value as Record<string, Json>).forEach(([ck, cv]) =>
      collectPaths(cv, childPath(path, ck), acc),
    );
  }
  return acc;
}
