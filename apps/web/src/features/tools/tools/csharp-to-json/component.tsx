// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-to-json/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ConverterLayout } from '@/features/tools/components/tool/ConverterLayout';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { csharpToJson, jsonToCsharp } from './logic';

type Direction = 'cs-to-json' | 'json-to-cs';

const EXAMPLE_CS = `public class UserResponse
{
    public string Name { get; set; }
    public int Age { get; set; }
    public bool Active { get; set; }
    public AddressDto Address { get; set; }
    public List<string> Tags { get; set; }
}

public class AddressDto
{
    public string Street { get; set; }
    public string City { get; set; }
}`;

const EXAMPLE_JSON = JSON.stringify(
  { id: 1, name: 'Ada', active: true, tags: ['a', 'b'], address: { city: 'X' } },
  null,
  2,
);

export default function CsharpJsonTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  // A Send-To payload is JSON, so a seeded tool starts in JSON → C#.
  const [dir, setDir] = useState<Direction>(
    initialInput !== undefined ? 'json-to-cs' : 'cs-to-json',
  );
  const [input, setInput] = useState(initialInput ?? EXAMPLE_CS);
  const [camelCase, setCamelCase] = useState(true);
  const [sampleValues, setSampleValues] = useState(false);
  const [useRecords, setUseRecords] = useState(false);
  const definition = getDefinition('csharp-to-json')!;

  const { output, error } = useMemo(() => {
    if (!input.trim()) return { output: '', error: null as string | null };
    try {
      return {
        output:
          dir === 'cs-to-json'
            ? csharpToJson(input, { camelCase, sampleValues })
            : jsonToCsharp(input, { useRecords }),
        error: null,
      };
    } catch (e) {
      return {
        output: '',
        error: e instanceof Error ? e.message : t('tools.items.csharp-to-json.failed'),
      };
    }
  }, [input, dir, camelCase, sampleValues, useRecords, t]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          <button
            onClick={() => setDir('cs-to-json')}
            className={`h-8 px-3 text-sm font-medium transition-colors ${
              dir === 'cs-to-json' ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
            }`}
          >
            C# → JSON
          </button>
          <button
            onClick={() => setDir('json-to-cs')}
            className={`h-8 px-3 text-sm font-medium transition-colors ${
              dir === 'json-to-cs' ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
            }`}
          >
            JSON → C#
          </button>
        </div>

        {dir === 'cs-to-json' ? (
          <>
            <label className="flex items-center gap-1.5 text-xs text-fg2">
              <input
                type="checkbox"
                checked={camelCase}
                onChange={(e) => setCamelCase(e.target.checked)}
              />
              camelCase
            </label>
            <label className="flex items-center gap-1.5 text-xs text-fg2">
              <input
                type="checkbox"
                checked={sampleValues}
                onChange={(e) => setSampleValues(e.target.checked)}
              />
              {t('tools.items.csharp-to-json.sampleValues')}
            </label>
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-fg3">
              {t('tools.items.csharp-to-json.looseMode')}
            </span>
          </>
        ) : (
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            <input
              type="checkbox"
              checked={useRecords}
              onChange={(e) => setUseRecords(e.target.checked)}
            />
            {t('tools.items.csharp-to-json.useRecords')}
          </label>
        )}
      </div>

      <ConverterLayout
        input={
          <ToolEditor
            label={dir === 'cs-to-json' ? 'C#' : 'JSON'}
            value={input}
            onChange={setInput}
            language={dir === 'cs-to-json' ? 'text' : 'json'}
            lineNumbers
            minRows={20}
            footer={error ? <span className="text-danger">{error}</span> : undefined}
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setInput(dir === 'cs-to-json' ? EXAMPLE_CS : EXAMPLE_JSON)}
              >
                {t('tools.common.sample')}
              </Button>
            }
          />
        }
        output={
          <ToolEditor
            label={dir === 'cs-to-json' ? 'JSON' : 'C#'}
            value={error ? '' : output}
            readOnly
            language={dir === 'cs-to-json' ? 'json' : 'text'}
            lineNumbers
            minRows={20}
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
