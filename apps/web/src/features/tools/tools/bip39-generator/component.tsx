// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bip39-generator/component.tsx. See THIRD_PARTY.md.
import { useCallback, useEffect, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import {
  bytesToHex,
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
  validateMnemonic,
} from './logic';
import { useI18n } from '@/lib/i18n/I18nContext';

const STRENGTHS: { words: number; bits: number }[] = [
  { words: 12, bits: 128 },
  { words: 15, bits: 160 },
  { words: 18, bits: 192 },
  { words: 21, bits: 224 },
  { words: 24, bits: 256 },
];

export default function Bip39GeneratorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [bits, setBits] = useState(128);
  const [mnemonic, setMnemonic] = useState('');
  const [entropyHex, setEntropyHex] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [seedHex, setSeedHex] = useState('');

  const [check, setCheck] = useState('');
  const [checkState, setCheckState] = useState<null | boolean>(null);

  const regenerate = useCallback(async (strength: number) => {
    const m = await generateMnemonic(strength);
    setMnemonic(m);
  }, []);

  // First mnemonic on mount, at the initial strength (128 bits).
  useEffect(() => {
    let alive = true;
    void generateMnemonic(128).then((m) => {
      if (alive) setMnemonic(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Keep entropy + seed in sync with the current mnemonic and passphrase.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!mnemonic) return;
      try {
        const entropy = await mnemonicToEntropy(mnemonic);
        const seed = await mnemonicToSeed(mnemonic, passphrase);
        if (!alive) return;
        setEntropyHex(bytesToHex(entropy));
        setSeedHex(bytesToHex(seed));
      } catch {
        if (!alive) return;
        setEntropyHex('');
        setSeedHex('');
      }
    })();
    return () => {
      alive = false;
    };
  }, [mnemonic, passphrase]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!check.trim()) {
        setCheckState(null);
        return;
      }
      const ok = await validateMnemonic(check);
      if (alive) setCheckState(ok);
    })();
    return () => {
      alive = false;
    };
  }, [check]);

  return (
    <div className="max-w-2xl space-y-5">
      <section className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.bip39-generator.length')}
            </span>
            <select
              value={bits}
              onChange={(e) => {
                const b = Number(e.target.value);
                setBits(b);
                regenerate(b);
              }}
              className="h-9 w-40 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {STRENGTHS.map((s) => (
                <option key={s.bits} value={s.bits}>
                  {t('tools.items.bip39-generator.wordsOption', { count: s.words, bits: s.bits })}
                </option>
              ))}
            </select>
          </label>
          <Button variant="primary" onClick={() => regenerate(bits)}>
            {t('tools.items.bip39-generator.generateNew')}
          </Button>
        </div>

        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-fg3">
              {t('tools.items.bip39-generator.mnemonic')}
            </span>
            <CopyButton size="sm" variant="ghost" value={mnemonic} />
          </div>
          <p className="font-mono text-base leading-relaxed text-fg">{mnemonic}</p>
        </div>

        <Field label={t('tools.items.bip39-generator.entropy')} value={entropyHex} />

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.bip39-generator.passphrase')}
          </span>
          <input
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            spellCheck={false}
            className="h-9 w-full rounded-md border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>

        <Field label={t('tools.items.bip39-generator.seed')} value={seedHex} mono wrap />
      </section>

      <section className="space-y-2 border-t border-line pt-4">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.bip39-generator.validate')}
        </span>
        <textarea
          value={check}
          onChange={(e) => setCheck(e.target.value)}
          spellCheck={false}
          rows={2}
          placeholder={t('tools.items.bip39-generator.validatePlaceholder')}
          className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
        {checkState !== null && (
          <p className={`text-sm ${checkState ? 'text-success' : 'text-danger'}`}>
            {checkState
              ? t('tools.items.bip39-generator.valid')
              : t('tools.items.bip39-generator.invalid')}
          </p>
        )}
      </section>

      <p className="text-xs text-fg3">{t('tools.items.bip39-generator.note')}</p>
    </div>
  );
}

function Field({
  label,
  value,
  wrap,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="w-40 shrink-0 text-xs text-fg3">{label}</span>
        <span
          className={`min-w-0 flex-1 font-mono text-sm text-fg ${wrap ? 'break-all' : 'truncate'}`}
        >
          {value || '—'}
        </span>
        <CopyButton size="sm" variant="ghost" value={value} className="shrink-0" />
      </div>
    </div>
  );
}
