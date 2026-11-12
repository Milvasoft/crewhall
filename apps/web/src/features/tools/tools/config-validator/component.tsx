// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/config-validator/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { useI18n } from '@/lib/i18n/I18nContext';
import { validateConfig, type ValidatorMode } from './logic';

const EXAMPLES: Record<ValidatorMode, string> = {
  yaml: 'name: example\nitems:\n  - one\n  - two\n',
  'docker-compose': "services:\n  web:\n    image: nginx:latest\n    ports:\n      - '80:80'\n",
  kubernetes:
    'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n',
};

const MODES: { id: ValidatorMode; label: string }[] = [
  { id: 'yaml', label: 'YAML' },
  { id: 'docker-compose', label: 'Docker Compose' },
  { id: 'kubernetes', label: 'Kubernetes' },
];

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * logic.ts reports issues as English sentences (its tests assert them); map each
 * known shape to a dictionary key here. Unknown messages are shown as they are.
 */
function localizeIssue(message: string, t: Translate): string {
  const k = 'tools.items.config-validator.issues';
  let m: RegExpMatchArray | null;
  if (message === 'Input is empty.') return t(`${k}.empty`);
  if ((m = message.match(/^Invalid YAML: ([\s\S]*)$/))) {
    return t(`${k}.invalidYaml`, { error: m[1] ?? '' });
  }
  if (message === 'Top-level document must be a mapping.') return t(`${k}.topLevelMapping`);
  if (message === 'Missing top-level `services:` mapping.') return t(`${k}.missingServices`);
  if ((m = message.match(/^Service "(.*)" must be a mapping\.$/))) {
    return t(`${k}.serviceMapping`, { name: m[1] ?? '' });
  }
  if ((m = message.match(/^Service "(.*)" has neither `image` nor `build`\.$/))) {
    return t(`${k}.serviceNoSource`, { name: m[1] ?? '' });
  }
  if (message === 'The top-level `version` field is obsolete in the Compose spec.') {
    return t(`${k}.versionObsolete`);
  }
  if ((m = message.match(/^(?:Document (\d+): )?must be a mapping\.$/))) {
    return m[1] ? t(`${k}.docMappingN`, { n: m[1] }) : t(`${k}.docMapping`);
  }
  if ((m = message.match(/^(?:Document (\d+): )?missing `(.+)`\.$/))) {
    const name = m[2] ?? '';
    return m[1] ? t(`${k}.missingFieldN`, { n: m[1], name }) : t(`${k}.missingField`, { name });
  }
  return message;
}

export default function ConfigValidatorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<ValidatorMode>('docker-compose');
  const [input, setInput] = useState(initialInput ?? EXAMPLES['docker-compose']);

  const report = useMemo(() => (input.trim() ? validateConfig(input, mode) : null), [input, mode]);

  return (
    <SplitGrid rightLabel={t('tools.common.result')}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-line">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setMode(m.id);
                  setInput(EXAMPLES[m.id]);
                }}
                className={`h-8 px-3 text-xs font-medium transition-colors ${
                  mode === m.id ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <ToolEditor
          label={t('tools.items.config-validator.config')}
          value={input}
          onChange={setInput}
          language="yaml"
          lineNumbers
          minRows={20}
        />
      </div>

      <div className="self-start">
        {report && (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div
              className={`border-b border-line px-3 py-2 text-sm font-semibold ${
                report.valid ? 'text-success' : 'text-danger'
              }`}
            >
              {report.valid
                ? `✓ ${t('tools.items.config-validator.valid')}`
                : `✗ ${t('tools.items.config-validator.errorCount', { count: report.errors.length })}`}
            </div>
            <div className="max-h-[60vh] overflow-auto p-3 text-sm">
              {report.errors.map((e, i) => (
                <div key={`e${i}`} className="flex gap-2 py-0.5">
                  <span className="text-danger">✗</span>
                  <span className="text-fg">{localizeIssue(e, t)}</span>
                </div>
              ))}
              {report.warnings.map((w, i) => (
                <div key={`w${i}`} className="flex gap-2 py-0.5">
                  <span className="text-warning">⚠</span>
                  <span className="text-fg2">{localizeIssue(w, t)}</span>
                </div>
              ))}
              {report.valid && report.warnings.length === 0 && (
                <p className="text-fg2">{t('tools.items.config-validator.noIssues')}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </SplitGrid>
  );
}
