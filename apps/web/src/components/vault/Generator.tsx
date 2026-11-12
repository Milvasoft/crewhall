import {
  CHARSETS,
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  passwordEntropyBits,
  PASSWORD_LENGTH,
  PASSPHRASE_WORDS,
} from '@crewhall/crypto';
import { Button, cn, Icon, IconButton, Segmented, Switch, Tooltip } from '@crewhall/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { saveSettings } from '@/lib/vault/api';
import { currentSettings, useVaultSession } from '@/lib/vault/session';
import { type VaultSettings } from '@/lib/vault/settings';
import { useCopy } from './fields';
import { strengthTone, useStrengthModule } from './strength';

/**
 * Password / passphrase generator (design 8.9, mobile 15.7): secure random with no modulo bias,
 * a new value on every change, digits and symbols dimmed for readability. Last settings are
 * remembered per account (encrypted settings).
 */
export function Generator({ onUse }: { onUse?: (value: string) => void }) {
  const { t } = useI18n();
  const { unlocked } = useVaultSession();
  const [prefs, setPrefs] = useState<VaultSettings['generator']>(() => currentSettings().generator);
  const [seed, setSeed] = useState(0);
  const copy = useCopy();
  const strength = useStrengthModule();

  const value = useMemo(() => {
    void seed;
    try {
      return prefs.mode === 'password'
        ? generatePassword(prefs.password)
        : generatePassphrase(prefs.passphrase);
    } catch {
      return '';
    }
  }, [prefs, seed]);
  const bits =
    prefs.mode === 'password'
      ? passwordEntropyBits(prefs.password)
      : passphraseEntropyBits(prefs.passphrase);
  const level = strength?.measureStrength(value).level;

  // Remember the settings (debounced) in the encrypted account settings.
  useEffect(() => {
    if (!unlocked) return;
    const id = setTimeout(() => {
      const s = currentSettings();
      if (JSON.stringify(s.generator) !== JSON.stringify(prefs)) {
        void saveSettings({ ...s, generator: prefs }).catch(() => undefined);
      }
    }, 800);
    return () => clearTimeout(id);
  }, [prefs, unlocked]);

  const setPw = (p: Partial<VaultSettings['generator']['password']>) =>
    setPrefs((x) => {
      const next = { ...x.password, ...p };
      // Keep at least one character set on.
      if (!next.upper && !next.lower && !next.digits && !next.symbols) return x;
      return { ...x, password: next };
    });
  const setPp = (p: Partial<VaultSettings['generator']['passphrase']>) =>
    setPrefs((x) => ({ ...x, passphrase: { ...x.passphrase, ...p } }));

  return (
    <div className="flex w-[380px] flex-col gap-4">
      <Segmented
        aria-label={t('vault.gen.mode')}
        value={prefs.mode}
        onValueChange={(mode) => setPrefs((x) => ({ ...x, mode }))}
        options={[
          { value: 'password', label: t('vault.gen.password') },
          { value: 'passphrase', label: t('vault.gen.passphrase') },
        ]}
      />
      <div className="flex items-start gap-2 rounded-lg bg-bg2 px-3.5 py-3">
        <output
          aria-live="polite"
          className="min-w-0 flex-1 font-mono text-[16px] leading-6 break-all"
        >
          <Colored value={value} />
        </output>
        <Tooltip content={t('vault.gen.again')}>
          <IconButton
            aria-label={t('vault.gen.again')}
            tone="plain"
            shape="sq"
            size="sm"
            onClick={() => setSeed((n) => n + 1)}
          >
            <Icon name="refresh" size={16} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="flex items-center justify-between text-xs">
        {level ? (
          <span className={cn('font-semibold', strengthTone(level))}>
            {t(`vault.strength.${level}`)}
          </span>
        ) : (
          <span />
        )}
        <span className="text-fg3 tn">{t('vault.gen.bits', { bits })}</span>
      </div>
      {prefs.mode === 'password' ? (
        <div className="flex flex-col gap-3">
          <Slider
            label={t('vault.gen.length')}
            value={prefs.password.length}
            min={PASSWORD_LENGTH.min}
            max={PASSWORD_LENGTH.max}
            onChange={(length) => setPw({ length })}
          />
          <Toggle
            label={t('vault.gen.upper')}
            hint="A–Z"
            checked={prefs.password.upper}
            onChange={(upper) => setPw({ upper })}
          />
          <Toggle
            label={t('vault.gen.lower')}
            hint="a–z"
            checked={prefs.password.lower}
            onChange={(lower) => setPw({ lower })}
          />
          <Toggle
            label={t('vault.gen.digits')}
            hint="0–9"
            checked={prefs.password.digits}
            onChange={(digits) => setPw({ digits })}
          />
          <Toggle
            label={t('vault.gen.symbols')}
            hint={CHARSETS.symbols}
            checked={prefs.password.symbols}
            onChange={(symbols) => setPw({ symbols })}
          />
          <Toggle
            label={t('vault.gen.avoidAmbiguous')}
            hint="l 1 I O 0"
            checked={prefs.password.avoidAmbiguous}
            onChange={(avoidAmbiguous) => setPw({ avoidAmbiguous })}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Slider
            label={t('vault.gen.words')}
            value={prefs.passphrase.words}
            min={PASSPHRASE_WORDS.min}
            max={PASSPHRASE_WORDS.max}
            onChange={(words) => setPp({ words })}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg">{t('vault.gen.language')}</span>
            <Segmented
              size="sm"
              aria-label={t('vault.gen.language')}
              value={prefs.passphrase.lang}
              onValueChange={(lang) => setPp({ lang })}
              options={[
                { value: 'tr', label: t('vault.gen.langTr') },
                { value: 'en', label: t('vault.gen.langEn') },
              ]}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fg">{t('vault.gen.separator')}</span>
            <Segmented
              size="sm"
              aria-label={t('vault.gen.separator')}
              value={prefs.passphrase.separator === ' ' ? 'space' : prefs.passphrase.separator}
              onValueChange={(sep) => setPp({ separator: sep === 'space' ? ' ' : sep })}
              options={[
                { value: '-', label: '-' },
                { value: '.', label: '.' },
                { value: '_', label: '_' },
                { value: 'space', label: t('vault.gen.space') },
              ]}
            />
          </div>
          <Toggle
            label={t('vault.gen.capitalize')}
            checked={prefs.passphrase.capitalize}
            onChange={(capitalize) => setPp({ capitalize })}
          />
          <Toggle
            label={t('vault.gen.includeNumber')}
            checked={prefs.passphrase.includeNumber}
            onChange={(includeNumber) => setPp({ includeNumber })}
          />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="out" onClick={() => void copy(value, 'vault.field.password')}>
          <Icon name="copy" size={15} />
          {t('vault.copy')}
        </Button>
        {onUse ? (
          <Button size="sm" variant="pri" onClick={() => onUse(value)}>
            {t('vault.gen.use')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Digits and symbols in a softer tone (design 8.9). */
export function Colored({ value }: { value: string }) {
  return (
    <>
      {[...value].map((ch, i) => (
        <span key={i} className={/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(ch) ? undefined : 'text-fg2'}>
          {ch}
        </span>
      ))}
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: ReactNode;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span className="flex items-baseline gap-2">
        <span className="text-fg">{label}</span>
        {hint ? <span className="font-mono text-xs text-fg3">{hint}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-fg">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--accent)]"
        aria-label={label}
      />
      <span className="w-8 text-right font-semibold tn">{value}</span>
    </label>
  );
}
