// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bcrypt-tool/component.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { hashPassword, verifyPassword } from './logic';

type Tab = 'hash' | 'verify';

export default function BcryptTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('hash');

  // Hash tab
  const [password, setPassword] = useState('');
  const [cost, setCost] = useState(10);
  const [hash, setHash] = useState('');
  const [hashing, setHashing] = useState(false);

  // Verify tab
  const [vPassword, setVPassword] = useState('');
  const [vHash, setVHash] = useState('');
  const [match, setMatch] = useState<null | boolean>(null);

  const runHash = async () => {
    setHashing(true);
    try {
      setHash(await hashPassword(password, cost));
    } finally {
      setHashing(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!vPassword || !vHash.trim()) {
        setMatch(null);
        return;
      }
      const ok = await verifyPassword(vPassword, vHash);
      if (alive) setMatch(ok);
    })();
    return () => {
      alive = false;
    };
  }, [vPassword, vHash]);

  return (
    <div className="max-w-2xl space-y-4">
      <div className="inline-flex overflow-hidden rounded-md border border-line">
        {(['hash', 'verify'] as Tab[]).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`h-8 px-4 text-sm font-medium transition-colors ${
              tab === id ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
            }`}
          >
            {t(`tools.items.bcrypt-tool.${id}`)}
          </button>
        ))}
      </div>

      {tab === 'hash' ? (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.bcrypt-tool.password')}
            </span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.bcrypt-tool.cost', { value: cost, count: 2 ** cost })}
            </span>
            <input
              type="range"
              min={4}
              max={15}
              value={cost}
              onChange={(e) => setCost(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
          </label>

          <Button variant="primary" onClick={runHash} disabled={hashing || !password}>
            {hashing ? t('tools.items.bcrypt-tool.hashing') : t('tools.items.bcrypt-tool.hash')}
          </Button>

          {hash && (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
              <span className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{hash}</span>
              <CopyButton size="sm" variant="ghost" value={hash} />
            </div>
          )}
          <p className="text-xs text-fg3">{t('tools.items.bcrypt-tool.hashNote')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.bcrypt-tool.password')}
            </span>
            <input
              value={vPassword}
              onChange={(e) => setVPassword(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.bcrypt-tool.bcryptHash')}
            </span>
            <input
              value={vHash}
              onChange={(e) => setVHash(e.target.value)}
              spellCheck={false}
              placeholder="$2b$10$…"
              className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
            />
          </label>
          {match !== null && (
            <p className={`text-sm ${match ? 'text-success' : 'text-danger'}`}>
              {match ? t('tools.items.bcrypt-tool.match') : t('tools.items.bcrypt-tool.noMatch')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
