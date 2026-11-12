// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/smart-paste/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { stageTransfer } from '@/features/tools/lib/transfer/transfer';
import { toolKey, useLocalizedTool } from '@/features/tools/i18n';
import { useI18n } from '@/lib/i18n/I18nContext';
import { detectContent, type Detection } from './logic';

const FALLBACK_TOOLS = ['string-length', 'text-compare', 'case-converter', 'escape'];

/** Detections whose label is prose (the others are format names such as JSON or SQL). */
const LOCALIZED_LABELS = new Set(['image', 'timestamp', 'connection-string', 'cron']);

/** `connection-string` → `connectionString`, the dictionary key of a detection type. */
const typeKey = (type: string) => type.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

export default function SmartPasteTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const localize = useLocalizedTool();
  const [input, setInput] = useState(initialInput ?? '');
  const navigate = useNavigate();

  const detections = useMemo(() => detectContent(input), [input]);

  const labelOf = (d: Detection) =>
    LOCALIZED_LABELS.has(d.type)
      ? t(toolKey('smart-paste', `types.${typeKey(d.type)}.label`))
      : d.label;
  const noteOf = (d: Detection) => t(toolKey('smart-paste', `types.${typeKey(d.type)}.note`));

  const openIn = (toolId: string) => {
    stageTransfer({ toolId, value: input });
    void navigate({ to: '/tools/$toolId', params: { toolId } });
  };

  const ToolButton = ({ id }: { id: string }) => {
    const def = getDefinition(id);
    if (!def) return null;
    return (
      <button
        onClick={() => openIn(id)}
        className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-accent hover:bg-accent10"
      >
        {localize(def).name} →
      </button>
    );
  };

  return (
    <div className="mx-auto max-w-3xl">
      <ToolEditor
        label={t('tools.items.smart-paste.inputLabel')}
        value={input}
        onChange={setInput}
        minRows={10}
        placeholder={t('tools.items.smart-paste.placeholder')}
      />

      <div className="mt-4">
        {!input.trim() ? (
          <p className="text-sm text-fg3">{t('tools.items.smart-paste.empty')}</p>
        ) : detections.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface p-4">
            <p className="text-sm text-fg">{t('tools.items.smart-paste.unknown')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {FALLBACK_TOOLS.map((id) => (
                <ToolButton key={id} id={id} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {detections.map((d, i) => (
              <div
                key={d.type}
                className={`rounded-lg border p-4 ${
                  i === 0 ? 'border-accent bg-accent10' : 'border-line bg-surface'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-fg">
                    {i === 0
                      ? t('tools.items.smart-paste.detected', { label: labelOf(d) })
                      : t('tools.items.smart-paste.alsoLooksLike', { label: labelOf(d) })}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-fg2">{noteOf(d)}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {d.toolIds.map((id) => (
                    <ToolButton key={id} id={id} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
