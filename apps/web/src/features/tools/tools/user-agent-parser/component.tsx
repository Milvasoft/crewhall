// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/user-agent-parser/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { parseUserAgent } from './logic';

// logic.ts returns English labels and fallbacks (asserted by its tests); translate here.
const LABELS = {
  Browser: 'browser',
  Engine: 'engine',
  'Operating system': 'os',
  Device: 'device',
  'Device type': 'deviceType',
  'CPU architecture': 'cpu',
} as const;

const VALUES = {
  Unknown: 'unknown',
  'Desktop / unknown': 'desktopUnknown',
  desktop: 'desktop',
} as const;

const has = <T extends object>(o: T, k: string): k is Extract<keyof T, string> =>
  Object.prototype.hasOwnProperty.call(o, k);

export default function UserAgentParserTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [input, setInput] = useState(initialInput ?? '');

  const fields = useMemo(() => (input.trim() ? parseUserAgent(input) : []), [input]);

  const k = 'tools.items.user-agent-parser';
  const labelOf = (label: string) =>
    has(LABELS, label) ? t(`${k}.fields.${LABELS[label]}`) : label;
  const valueOf = (value: string) =>
    has(VALUES, value) ? t(`${k}.values.${VALUES[value]}`) : value;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-col gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          rows={3}
          placeholder={t(`${k}.placeholder`)}
          className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
        <div>
          <Button size="sm" variant="secondary" onClick={() => setInput(navigator.userAgent)}>
            {t(`${k}.useMine`)}
          </Button>
        </div>
      </div>

      {fields.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {fields.map((f) => {
            const value = valueOf(f.value);
            return (
              <div
                key={f.label}
                className="group flex items-center gap-3 border-b border-line/60 px-3 py-2.5 last:border-0"
              >
                <span className="w-36 shrink-0 text-xs text-fg3">{labelOf(f.label)}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{value}</span>
                <CopyButton
                  size="sm"
                  variant="ghost"
                  value={value}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
