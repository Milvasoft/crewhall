// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/aes/component.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { aesDecrypt, aesEncrypt } from './logic';

type Mode = 'encrypt' | 'decrypt';

/** Messages thrown by ./logic, mapped to dictionary keys. */
const ERROR_KEYS = {
  'A passphrase is required.': 'tools.items.aes.errors.passphraseRequired',
  'Ciphertext is too short or malformed.': 'tools.items.aes.errors.tooShort',
  'Decryption failed, wrong passphrase or corrupted data.': 'tools.items.aes.errors.decryptFailed',
} as const;

interface Result {
  output: string;
  error: string | null;
}

export default function AesTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('encrypt');
  const [password, setPassword] = useState('');
  const [input, setInput] = useState(initialInput ?? '');
  const [result, setResult] = useState<Result>({ output: '', error: null });
  const definition = getDefinition('aes')!;

  useEffect(() => {
    if (!input || !password) return;
    let cancelled = false;
    const run = mode === 'encrypt' ? aesEncrypt(input, password) : aesDecrypt(input, password);
    run
      .then((r) => {
        if (!cancelled) setResult({ output: r, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ output: '', error: e instanceof Error ? e.message : '' });
      });
    return () => {
      cancelled = true;
    };
  }, [input, password, mode]);

  // With no input or passphrase there is nothing to show.
  const active = input && password ? result : { output: '', error: null };
  const output = active.output;
  const errorKey = active.error ? ERROR_KEYS[active.error as keyof typeof ERROR_KEYS] : undefined;
  const error =
    active.error === null
      ? null
      : errorKey
        ? t(errorKey)
        : active.error || t('tools.items.aes.errors.failed');

  const plaintext = t('tools.items.aes.plaintext');
  const ciphertext = t('tools.items.aes.ciphertext');

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['encrypt', 'decrypt'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                mode === m ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.aes.${m}`)}
            </button>
          ))}
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('tools.items.aes.passphrase')}
          aria-label={t('tools.items.aes.passphrase')}
          className="h-8 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
        />
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={mode === 'encrypt' ? plaintext : ciphertext}
            value={input}
            onChange={setInput}
            minRows={12}
          />
        }
        output={
          <ToolEditor
            label={mode === 'encrypt' ? ciphertext : plaintext}
            value={error ? '' : output}
            readOnly
            minRows={12}
            footer={error ? <span className="text-danger">{error}</span> : undefined}
            actions={
              <>
                <CopyButton size="sm" variant="ghost" value={output} />
                <SendToMenu source={definition} value={output} />
              </>
            }
          />
        }
      />
      <p className="mt-2 text-[11px] text-fg3">{t('tools.items.aes.note')}</p>
    </div>
  );
}
