// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/math-evaluator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { evaluateExpression } from './logic';

const EXAMPLES = [
  'sqrt(16) + 2 ^ 3',
  'sin(pi / 2)',
  'max(3, 7, 2) * 10',
  'log(1000)',
  '(1 + 5) / 2 % 2',
];

const FUNCTION_NAMES =
  'sqrt, cbrt, abs, round, floor, ceil, sin, cos, tan, asin, acos, atan, ln, log, log2, exp, min, max, pow, hypot, root';
const CONSTANT_NAMES = 'pi, e, tau, phi';

export default function MathEvaluatorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? 'sqrt(16) + 2 ^ 3');

  const { result, error } = useMemo(() => {
    if (!input.trim()) return { result: '', error: null as string | null };
    try {
      return { result: String(evaluateExpression(input)), error: null };
    } catch (e) {
      return {
        result: '',
        error: e instanceof Error ? e.message : t('tools.items.math-evaluator.invalid'),
      };
    }
  }, [input, t]);

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.math-evaluator.expression')}
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          className="h-12 w-full rounded-lg border border-line bg-surface px-3 font-mono text-lg text-fg focus:border-accent focus:outline-none"
        />
      </label>

      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <span className="text-sm text-fg3">=</span>
        {error ? (
          <span className="text-sm text-danger">{error}</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 break-all font-mono text-2xl font-semibold text-fg">
              {result || '—'}
            </span>
            <CopyButton size="sm" variant="ghost" value={result} />
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => setInput(ex)}
            className="rounded-md border border-line bg-surface px-2.5 py-1 font-mono text-xs text-fg2 transition-colors hover:border-accent hover:text-fg"
          >
            {ex}
          </button>
        ))}
      </div>

      <p className="text-xs text-fg3">
        {t('tools.items.math-evaluator.functions', { items: FUNCTION_NAMES })}{' '}
        {t('tools.items.math-evaluator.constants', { items: CONSTANT_NAMES })}
      </p>
    </div>
  );
}
