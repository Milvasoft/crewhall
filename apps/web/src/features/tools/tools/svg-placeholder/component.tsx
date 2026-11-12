// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/svg-placeholder/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { generateSvg, svgToDataUri, type SvgOptions } from './logic';

export default function SvgPlaceholderTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [opts, setOpts] = useState<SvgOptions>({
    width: 480,
    height: 240,
    bg: '#1f6feb',
    fg: '#ffffff',
    text: '',
  });

  const svg = useMemo(() => generateSvg({ ...opts, text: opts.text || undefined }), [opts]);
  const dataUri = useMemo(() => svgToDataUri(svg), [svg]);
  const set = <K extends keyof SvgOptions>(k: K, v: SvgOptions[K]) =>
    setOpts((o) => ({ ...o, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <Num
          label={t('tools.items.svg-placeholder.width')}
          value={opts.width}
          onChange={(v) => set('width', v)}
        />
        <Num
          label={t('tools.items.svg-placeholder.height')}
          value={opts.height}
          onChange={(v) => set('height', v)}
        />
        <Color
          label={t('tools.items.svg-placeholder.background')}
          value={opts.bg}
          onChange={(v) => set('bg', v)}
        />
        <Color
          label={t('tools.items.svg-placeholder.textColor')}
          value={opts.fg}
          onChange={(v) => set('fg', v)}
        />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.svg-placeholder.textOptional')}
          </span>
          <input
            value={opts.text ?? ''}
            onChange={(e) => set('text', e.target.value)}
            placeholder={`${opts.width}×${opts.height}`}
            className="h-9 w-40 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="flex justify-center overflow-auto rounded-lg border border-line bg-[repeating-conic-gradient(var(--surface-secondary)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px] p-4">
        <img
          src={dataUri}
          alt={t('tools.items.svg-placeholder.previewAlt')}
          className="max-w-full"
        />
      </div>

      <Output label={t('tools.items.svg-placeholder.markup')} value={svg} />
      <Output label={t('tools.items.svg-placeholder.dataUri')} value={dataUri} />
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg2">{label}</span>
      <input
        type="number"
        min={1}
        max={4000}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.min(4000, Number(e.target.value) || 1)))}
        className="h-9 w-24 rounded-md border border-line bg-surface px-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
      />
    </label>
  );
}

function Color({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg2">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-9 cursor-pointer rounded border border-line bg-surface"
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-24 rounded-md border border-line bg-surface px-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
        />
      </div>
    </label>
  );
}

function Output({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
      <span className="w-24 shrink-0 text-xs text-fg3">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{value}</span>
      <CopyButton size="sm" variant="ghost" value={value} />
    </div>
  );
}
