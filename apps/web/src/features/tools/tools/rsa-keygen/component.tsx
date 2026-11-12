// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/rsa-keygen/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { generateRsaKeyPair, type RsaKeyPair } from './logic';

export default function RsaKeygenTool(_props: ToolComponentProps) {
  const { t } = useI18n();
  const [bits, setBits] = useState(2048);
  const [pair, setPair] = useState<RsaKeyPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      setPair(await generateRsaKeyPair(bits));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('tools.items.rsa-keygen.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-fg2">
          {t('tools.items.rsa-keygen.modulus')}
          <select
            value={bits}
            onChange={(e) => setBits(Number(e.target.value))}
            className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
          >
            {[2048, 3072, 4096].map((b) => (
              <option key={b} value={b}>
                {t('tools.items.rsa-keygen.bitsOption', { bits: b })}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="sm" onClick={generate} disabled={busy}>
          {busy ? t('tools.items.rsa-keygen.generating') : t('tools.items.rsa-keygen.generate')}
        </Button>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ToolEditor
          label={t('tools.items.rsa-keygen.publicKey')}
          value={pair?.publicKey ?? ''}
          readOnly
          minRows={16}
          actions={<CopyButton size="sm" variant="ghost" value={pair?.publicKey ?? ''} />}
        />
        <ToolEditor
          label={t('tools.items.rsa-keygen.privateKey')}
          value={pair?.privateKey ?? ''}
          readOnly
          minRows={16}
          actions={<CopyButton size="sm" variant="ghost" value={pair?.privateKey ?? ''} />}
        />
      </div>
      <p className="mt-2 text-[11px] text-fg3">{t('tools.items.rsa-keygen.note')}</p>
    </div>
  );
}
