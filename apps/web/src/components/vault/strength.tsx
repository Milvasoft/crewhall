import { cn, Icon } from '@crewhall/ui';
import type * as StrengthNs from '@crewhall/crypto/strength';
import { useEffect, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';

/**
 * zxcvbn-ts strength, loaded lazily: its dictionaries are large and only the vault needs them.
 * Everything runs on the device; nothing about the password leaves it.
 */

type StrengthModule = typeof StrengthNs;
let loaded: StrengthModule | null = null;
let loading: Promise<StrengthModule> | null = null;

export function loadStrength(): Promise<StrengthModule> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import('@crewhall/crypto/strength').then((m) => (loaded = m));
  return loading;
}

export function useStrengthModule(): StrengthModule | null {
  const [m, setM] = useState<StrengthModule | null>(loaded);
  useEffect(() => {
    if (!m) void loadStrength().then(setM);
  }, [m]);
  return m;
}

const LEVEL_KEY = {
  weak: 'vault.strength.weak',
  fair: 'vault.strength.fair',
  strong: 'vault.strength.strong',
  very_strong: 'vault.strength.very_strong',
} as const satisfies Record<string, MessageKey>;

export function strengthTone(level: keyof typeof LEVEL_KEY) {
  return level === 'weak' ? 'text-danger' : level === 'fair' ? 'text-warning' : 'text-success';
}

/** Human crack time ("yüzyıllar", "3 gün") from seconds, via i18n plural messages. */
export function useCrackTime() {
  const { t } = useI18n();
  return (seconds: number) => {
    const units: [number, MessageKey][] = [
      [3600 * 24 * 365 * 100, 'vault.crack.centuries'],
      [3600 * 24 * 365, 'vault.crack.years'],
      [3600 * 24 * 30, 'vault.crack.months'],
      [3600 * 24, 'vault.crack.days'],
      [3600, 'vault.crack.hours'],
      [60, 'vault.crack.minutes'],
    ];
    for (const [size, key] of units) {
      if (seconds >= size) {
        return key === 'vault.crack.centuries' ? t(key) : t(key, { n: Math.floor(seconds / size) });
      }
    }
    return t('vault.crack.instant');
  };
}

/** Four-segment meter (design 8.1) with the label and estimated crack time. */
export function StrengthBar({ password, inputs = [] }: { password: string; inputs?: string[] }) {
  const { t } = useI18n();
  const m = useStrengthModule();
  const crack = useCrackTime();
  if (!password) return null;
  const s = m?.measureStrength(password, inputs);
  const filled = s ? Math.max(1, s.score) : 0;
  const tone = s ? strengthTone(s.level) : 'text-fg3';
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn('h-1 flex-1 rounded-full bg-line2', i <= filled && 'bg-current', tone)}
          />
        ))}
      </div>
      {s ? (
        <div className="flex items-center justify-between text-xs">
          <span className={cn('font-semibold', tone)}>{t(LEVEL_KEY[s.level])}</span>
          <span className="text-fg3 tn">
            {t('vault.strength.detail', { length: s.length, time: crack(s.crackSeconds) })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Small badge next to a stored password ("Güçlü"). */
export function StrengthBadge({ password }: { password: string }) {
  const { t } = useI18n();
  const m = useStrengthModule();
  if (!m || !password) return null;
  const s = m.measureStrength(password);
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs font-semibold', strengthTone(s.level))}
    >
      <Icon name="shield" size={13} />
      {t(LEVEL_KEY[s.level])}
    </span>
  );
}
