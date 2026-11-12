// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/appsettings-env/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { envToJson, jsonToEnv, type OutputFormat } from './logic';

type Direction = 'json-to-env' | 'env-to-json';

/** Format ids with a fixed label (product names); the others are translated. */
const FORMATS: { id: OutputFormat; label?: string }[] = [
  { id: 'double-underscore' },
  { id: 'colon' },
  { id: 'dotenv', label: '.env' },
  { id: 'bash', label: 'Bash export' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'docker-compose', label: 'Docker Compose' },
  { id: 'k8s-configmap', label: 'Kubernetes ConfigMap' },
];

const EXAMPLE = JSON.stringify(
  {
    ConnectionStrings: { Default: 'Server=localhost;Database=test' },
    Jwt: { Issuer: 'example', ExpirationMinutes: 60 },
    Features: { EnableCache: true },
    Cors: { Origins: ['https://a.com', 'https://b.com'] },
  },
  null,
  2,
);

export default function AppsettingsEnvTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [direction, setDirection] = useState<Direction>('json-to-env');
  const [format, setFormat] = useState<OutputFormat>('double-underscore');
  const [input, setInput] = useState(initialInput ?? EXAMPLE);
  const definition = getDefinition('appsettings-env')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    try {
      return {
        output: direction === 'json-to-env' ? jsonToEnv(input, format) : envToJson(input),
        error: null,
      };
    } catch (e) {
      return {
        output: '',
        error: e instanceof Error ? e.message : t('tools.items.appsettings-env.failed'),
      };
    }
  }, [input, direction, format, t]);

  const formatLabel = (f: { id: OutputFormat; label?: string }) => {
    if (f.label) return f.label;
    return f.id === 'colon'
      ? t('tools.items.appsettings-env.formats.colon')
      : t('tools.items.appsettings-env.formats.doubleUnderscore');
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          <button
            onClick={() => setDirection('json-to-env')}
            className={`h-8 px-3 text-sm font-medium transition-colors ${
              direction === 'json-to-env'
                ? 'bg-accent text-accent-fg'
                : 'bg-surface text-fg2 hover:bg-bg2'
            }`}
          >
            JSON → Env
          </button>
          <button
            onClick={() => setDirection('env-to-json')}
            className={`h-8 px-3 text-sm font-medium transition-colors ${
              direction === 'env-to-json'
                ? 'bg-accent text-accent-fg'
                : 'bg-surface text-fg2 hover:bg-bg2'
            }`}
          >
            Env → JSON
          </button>
        </div>

        {direction === 'json-to-env' && (
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.appsettings-env.format')}
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as OutputFormat)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
            >
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {formatLabel(f)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={
              direction === 'json-to-env'
                ? 'appsettings.json'
                : t('tools.items.appsettings-env.envVars')
            }
            value={input}
            onChange={setInput}
            language={direction === 'json-to-env' ? 'json' : 'text'}
            lineNumbers
            minRows={18}
            placeholder={
              direction === 'json-to-env'
                ? t('tools.items.appsettings-env.jsonPlaceholder')
                : t('tools.items.appsettings-env.envPlaceholder')
            }
            actions={
              <>
                {direction === 'json-to-env' && (
                  <Button size="sm" variant="ghost" onClick={() => setInput(EXAMPLE)}>
                    {t('tools.common.sample')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setInput('')}>
                  {t('tools.common.clear')}
                </Button>
              </>
            }
          />
        }
        output={
          <ToolEditor
            label={direction === 'json-to-env' ? t('tools.items.appsettings-env.envVars') : 'JSON'}
            value={error ? '' : output}
            readOnly
            language={direction === 'env-to-json' ? 'json' : 'text'}
            lineNumbers
            minRows={18}
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
    </div>
  );
}
