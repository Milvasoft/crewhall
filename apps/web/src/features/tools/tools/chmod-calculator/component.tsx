// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chmod-calculator/component.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { fromOctal, toOctal, toSymbolic, type Perm, type Permissions } from './logic';
import { useI18n } from '@/lib/i18n/I18nContext';

type Scope = 'owner' | 'group' | 'other';
type Bit = 'read' | 'write' | 'execute';

const SCOPES: Scope[] = ['owner', 'group', 'other'];
const BITS: { key: Bit; value: number }[] = [
  { key: 'read', value: 4 },
  { key: 'write', value: 2 },
  { key: 'execute', value: 1 },
];

const EMPTY: Perm = { read: false, write: false, execute: false };

export default function ChmodCalculatorTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [perms, setPerms] = useState<Permissions>({
    owner: { read: true, write: true, execute: true },
    group: { read: true, write: false, execute: true },
    other: { read: true, write: false, execute: true },
  });

  const octal = toOctal(perms);
  const symbolic = toSymbolic(perms);

  const toggle = (scope: Scope, bit: Bit) =>
    setPerms((p) => ({ ...p, [scope]: { ...p[scope], [bit]: !p[scope][bit] } }));

  const onOctal = (v: string) => {
    try {
      setPerms(fromOctal(v));
    } catch {
      // ignore partial/invalid entries while typing
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg2 text-left text-xs uppercase tracking-wide text-fg2">
              <th className="px-3 py-2 font-semibold">{t('tools.items.chmod-calculator.who')}</th>
              {BITS.map((b) => (
                <th key={b.key} className="px-3 py-2 text-center font-semibold">
                  {t(`tools.items.chmod-calculator.bits.${b.key}`)} ({b.value})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SCOPES.map((scope) => (
              <tr key={scope} className="border-t border-line/60">
                <td className="px-3 py-2 text-fg">
                  {t(`tools.items.chmod-calculator.scopes.${scope}`)}
                </td>
                {BITS.map((b) => (
                  <td key={b.key} className="px-3 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={(perms[scope] ?? EMPTY)[b.key]}
                      onChange={() => toggle(scope, b.key)}
                      className="h-4 w-4 accent-[var(--accent)]"
                      aria-label={`${t(`tools.items.chmod-calculator.scopes.${scope}`)}, ${t(`tools.items.chmod-calculator.bits.${b.key}`)}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.chmod-calculator.octal')}
          </span>
          <div className="flex items-center gap-2">
            <input
              value={octal}
              onChange={(e) => onOctal(e.target.value)}
              spellCheck={false}
              className="h-11 w-28 rounded-lg border border-line bg-surface px-3 font-mono text-lg text-fg focus:border-accent focus:outline-none"
            />
            <CopyButton size="sm" variant="ghost" value={octal} />
          </div>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.chmod-calculator.symbolic')}
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg tracking-widest text-fg">{symbolic}</span>
            <CopyButton size="sm" variant="ghost" value={symbolic} />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.chmod-calculator.command')}
          </span>
          <div className="flex items-center gap-2">
            <code className="rounded bg-bg2 px-2 py-1 font-mono text-sm text-fg">
              chmod {octal} file
            </code>
            <CopyButton size="sm" variant="ghost" value={`chmod ${octal} file`} />
          </div>
        </div>
      </div>
    </div>
  );
}
