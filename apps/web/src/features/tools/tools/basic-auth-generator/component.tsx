// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/basic-auth-generator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { basicAuth } from './logic';

export default function BasicAuthGeneratorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [username, setUsername] = useState('Aladdin');
  const [password, setPassword] = useState('open sesame');

  const result = useMemo(() => basicAuth(username, password), [username, password]);

  const rows: [string, string][] = [
    [t('tools.items.basic-auth-generator.header'), result.header],
    [t('tools.items.basic-auth-generator.token'), result.token],
    ['curl', result.curl],
  ];

  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.basic-auth-generator.username')}
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.basic-auth-generator.password')}
          </span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="group flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
          >
            <span className="w-40 shrink-0 text-xs text-fg3">{label}</span>
            <span className="min-w-0 flex-1 break-all font-mono text-sm text-fg">{value}</span>
            <CopyButton
              size="sm"
              variant="ghost"
              value={value}
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            />
          </div>
        ))}
      </div>

      <p className="text-xs text-fg3">{t('tools.items.basic-auth-generator.note')}</p>
    </div>
  );
}
