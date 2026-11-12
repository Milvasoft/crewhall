// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-generator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import {
  estimateEntropyBits,
  generateKey,
  generatePassword,
  type KeyEncoding,
  type PasswordOptions,
} from './logic';
import { useI18n } from '@/lib/i18n/I18nContext';

type Mode = 'password' | 'key';

export default function PasswordGeneratorTool(_props: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('password');
  const [opts, setOpts] = useState<PasswordOptions>({
    length: 20,
    lowercase: true,
    uppercase: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: false,
  });
  const [count, setCount] = useState(5);
  const [bits, setBits] = useState(256);
  const [encoding, setEncoding] = useState<KeyEncoding>('hex');
  // Bumped by the Generate button to get a fresh batch with the same options.
  const [batch, setBatch] = useState(0);
  const definition = getDefinition('password-generator')!;

  const output = useMemo(() => {
    void batch;
    try {
      const lines: string[] = [];
      for (let i = 0; i < Math.max(1, Math.min(count, 500)); i++) {
        lines.push(mode === 'password' ? generatePassword(opts) : generateKey(bits, encoding));
      }
      return lines.join('\n');
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      return message === 'Select at least one character set.'
        ? t('tools.items.password-generator.noCharset')
        : message || t('tools.common.error');
    }
  }, [mode, opts, count, bits, encoding, batch, t]);

  const toggle = (key: keyof PasswordOptions) => setOpts((o) => ({ ...o, [key]: !o[key] }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      <div className="flex flex-col gap-4 self-start">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['password', 'key'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-8 flex-1 px-3 text-sm font-medium transition-colors ${
                mode === m ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.password-generator.modes.${m}`)}
            </button>
          ))}
        </div>

        {mode === 'password' ? (
          <>
            <label className="flex items-center justify-between text-xs text-fg2">
              {t('tools.items.password-generator.length')}{' '}
              <span className="font-mono text-fg">{opts.length}</span>
            </label>
            <input
              type="range"
              min={4}
              max={64}
              value={opts.length}
              onChange={(e) => setOpts((o) => ({ ...o, length: Number(e.target.value) }))}
            />
            {(
              [
                ['lowercase', '(a-z)'],
                ['uppercase', '(A-Z)'],
                ['digits', '(0-9)'],
                ['symbols', '(!@#…)'],
                ['avoidAmbiguous', '(Il1O0)'],
              ] as [Exclude<keyof PasswordOptions, 'length'>, string][]
            ).map(([key, sample]) => (
              <label key={key} className="flex items-center gap-2 text-xs text-fg2">
                <input type="checkbox" checked={!!opts[key]} onChange={() => toggle(key)} />
                {t(`tools.items.password-generator.sets.${key}`)} {sample}
              </label>
            ))}
            <p className="text-[11px] text-fg3">
              {t('tools.items.password-generator.entropy', { bits: estimateEntropyBits(opts) })}
            </p>
          </>
        ) : (
          <>
            <label className="flex items-center justify-between text-xs text-fg2">
              {t('tools.items.password-generator.size')}
              <select
                value={bits}
                onChange={(e) => setBits(Number(e.target.value))}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
              >
                {[128, 192, 256, 384, 512].map((b) => (
                  <option key={b} value={b}>
                    {t('tools.items.password-generator.bitsOption', { bits: b })}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between text-xs text-fg2">
              {t('tools.items.password-generator.encoding')}
              <select
                value={encoding}
                onChange={(e) => setEncoding(e.target.value as KeyEncoding)}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
              >
                <option value="hex">Hex</option>
                <option value="base64">Base64</option>
                <option value="base64url">Base64URL</option>
              </select>
            </label>
          </>
        )}

        <label className="flex items-center justify-between text-xs text-fg2">
          {t('tools.items.password-generator.count')}
          <input
            type="number"
            min={1}
            max={500}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
            className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-right text-sm outline-none"
          />
        </label>

        <Button variant="primary" onClick={() => setBatch((b) => b + 1)}>
          {t('tools.common.generate')}
        </Button>
      </div>

      <ToolEditor
        label={t('tools.items.password-generator.total', {
          count: output ? output.split('\n').length : 0,
        })}
        value={output}
        readOnly
        lineNumbers
        minRows={16}
        actions={
          <>
            <CopyButton
              size="sm"
              variant="ghost"
              value={output}
              label={t('tools.items.password-generator.copyAll')}
            />
            <SendToMenu source={definition} value={output} />
          </>
        }
      />
    </div>
  );
}
