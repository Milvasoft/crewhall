// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-strength-analyser/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { useI18n } from '@/lib/i18n/I18nContext';
import { analyzePassword } from './logic';

const SCORE_KEYS = ['veryWeak', 'weak', 'fair', 'strong', 'veryStrong'] as const;

/** Warnings produced by ./logic, mapped to dictionary keys. */
const WARNING_KEYS = {
  'Shorter than 8 characters.': 'tools.items.password-strength-analyser.warnings.short',
  'No uppercase letters.': 'tools.items.password-strength-analyser.warnings.noUpper',
  'No digits.': 'tools.items.password-strength-analyser.warnings.noDigits',
  'No symbols.': 'tools.items.password-strength-analyser.warnings.noSymbols',
  'A single repeated character.': 'tools.items.password-strength-analyser.warnings.repeated',
  'Digits only.': 'tools.items.password-strength-analyser.warnings.digitsOnly',
} as const;

const TIME_UNITS = ['second', 'minute', 'hour', 'day', 'year'] as const;

const BAR_COLORS = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];

export default function PasswordStrengthAnalyserTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [pw, setPw] = useState(initialInput ?? '');
  const [reveal, setReveal] = useState(false);

  const result = useMemo(() => analyzePassword(pw), [pw]);

  // ./logic returns English text ("instantly", "centuries", "3 days"); show it translated.
  const crackTime = (() => {
    const text = result.crackTimeText;
    if (text === 'instantly') return t('tools.items.password-strength-analyser.time.instantly');
    if (text === 'centuries') return t('tools.items.password-strength-analyser.time.centuries');
    const m = /^(\d+) (second|minute|hour|day|year)s?$/.exec(text);
    const unit = TIME_UNITS.find((u) => u === m?.[2]);
    return m && unit
      ? t(`tools.items.password-strength-analyser.time.${unit}`, { count: Number(m[1]) })
      : text;
  })();

  return (
    <div className="max-w-2xl space-y-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.password-strength-analyser.password')}
        </span>
        <div className="flex gap-2">
          <input
            type={reveal ? 'text' : 'password'}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('tools.items.password-strength-analyser.placeholder')}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="h-10 shrink-0 rounded-lg border border-line px-3 text-xs text-fg2 transition-colors hover:bg-bg2"
          >
            {reveal
              ? t('tools.items.password-strength-analyser.hide')
              : t('tools.items.password-strength-analyser.show')}
          </button>
        </div>
      </label>

      {/* Strength meter */}
      <div className="flex gap-1.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full ${
              pw && i <= result.score ? BAR_COLORS[result.score] : 'bg-line'
            }`}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-lg font-semibold text-fg">
          {t(`tools.items.password-strength-analyser.score.${SCORE_KEYS[result.score]}`)}
        </span>
        <span className="text-sm text-fg2">
          {t('tools.items.password-strength-analyser.entropyLine', { bits: result.entropyBits })}
        </span>
        <span className="text-sm text-fg2">
          {t('tools.items.password-strength-analyser.crackTime')}{' '}
          <span className="text-fg">{crackTime}</span>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Stat
          label={t('tools.items.password-strength-analyser.stats.length')}
          value={String(result.length)}
        />
        <Stat
          label={t('tools.items.password-strength-analyser.stats.pool')}
          value={String(result.poolSize)}
        />
        <Stat
          label={t('tools.items.password-strength-analyser.stats.entropy')}
          value={t('tools.items.password-strength-analyser.bits', { bits: result.entropyBits })}
        />
        <Stat
          label={t('tools.items.password-strength-analyser.stats.score')}
          value={`${result.score} / 4`}
        />
      </div>

      {result.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-line bg-bg2 p-3 text-sm text-fg2">
          {result.warnings.map((w) => (
            <li key={w}>
              • {w in WARNING_KEYS ? t(WARNING_KEYS[w as keyof typeof WARNING_KEYS]) : w}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-fg3">{t('tools.items.password-strength-analyser.note')}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-xs text-fg3">{label}</div>
      <div className="font-mono text-fg">{value}</div>
    </div>
  );
}
