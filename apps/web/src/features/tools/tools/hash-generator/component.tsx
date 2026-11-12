// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/hash-generator/component.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { HASH_ALGOS, hash, hmac, type HashAlgo } from './logic';

export default function HashGeneratorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? '');
  const [algo, setAlgo] = useState<HashAlgo>('SHA-256');
  const [useHmac, setUseHmac] = useState(false);
  const [key, setKey] = useState('');
  const [digest, setDigest] = useState('');
  const definition = getDefinition('hash-generator')!;

  useEffect(() => {
    if (!input) return;
    let cancelled = false;
    const compute = useHmac ? hmac(input, key, algo) : hash(input, algo);
    compute
      .then((h) => {
        if (!cancelled) setDigest(h);
      })
      .catch(() => {
        if (!cancelled) setDigest('');
      });
    return () => {
      cancelled = true;
    };
  }, [input, algo, useHmac, key]);

  // Empty input has no digest.
  const output = input ? digest : '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.hash-generator.algorithm')}
          <select
            value={algo}
            onChange={(e) => setAlgo(e.target.value as HashAlgo)}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            {HASH_ALGOS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          <input type="checkbox" checked={useHmac} onChange={(e) => setUseHmac(e.target.checked)} />
          HMAC
        </label>
        {useHmac && (
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('tools.items.hash-generator.secretKey')}
            aria-label={t('tools.items.hash-generator.hmacKey')}
            className="h-8 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg outline-none focus:border-accent"
          />
        )}
      </div>

      <ToolEditor
        label={t('tools.common.input')}
        value={input}
        onChange={setInput}
        minRows={6}
        placeholder={t('tools.items.hash-generator.placeholder')}
      />

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fg2">
          <span>
            {useHmac ? 'HMAC' : t('tools.items.hash-generator.digest')} · {algo}{' '}
            {output ? `· ${t('tools.items.hash-generator.bits', { bits: output.length * 4 })}` : ''}
          </span>
          <div className="flex items-center gap-1">
            <CopyButton size="sm" variant="ghost" value={output} />
            <SendToMenu source={definition} value={output} />
          </div>
        </div>
        <pre className="overflow-auto break-all px-3 py-3 font-mono text-sm text-fg">
          {output || <span className="text-fg3">—</span>}
        </pre>
      </div>

      <p className="text-[11px] text-fg3">{t('tools.items.hash-generator.note')}</p>
    </div>
  );
}
