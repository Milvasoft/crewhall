// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-xml/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { jsonToXml, xmlToJson } from './logic';

const EXAMPLE = JSON.stringify(
  { note: { '@_id': 1, to: 'Ada', from: 'Grace', body: 'Hello' } },
  null,
  2,
);

export default function JsonXmlTool({ initialInput }: ToolComponentProps) {
  return (
    <BiConverter
      definition={getDefinition('json-xml')!}
      leftLabel="JSON"
      rightLabel="XML"
      leftLanguage="json"
      rightLanguage="xml"
      forward={jsonToXml}
      backward={xmlToJson}
      example={EXAMPLE}
      initialInput={initialInput}
      createWorker={() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })}
    />
  );
}
