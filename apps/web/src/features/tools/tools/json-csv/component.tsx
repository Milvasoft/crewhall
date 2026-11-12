// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-csv/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { csvToJson, jsonToCsv } from './logic';

const EXAMPLE = JSON.stringify(
  [
    { id: 1, name: 'Ada', active: true },
    { id: 2, name: 'Grace', active: false },
  ],
  null,
  2,
);

export default function JsonCsvTool({ initialInput }: ToolComponentProps) {
  return (
    <BiConverter
      definition={getDefinition('json-csv')!}
      leftLabel="JSON"
      rightLabel="CSV"
      leftLanguage="json"
      forward={jsonToCsv}
      backward={csvToJson}
      example={EXAMPLE}
      initialInput={initialInput}
      createWorker={() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })}
    />
  );
}
