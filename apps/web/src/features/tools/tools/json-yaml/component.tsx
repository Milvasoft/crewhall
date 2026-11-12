// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-yaml/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { jsonToYaml, yamlToJson } from './logic';

const EXAMPLE = JSON.stringify(
  { name: 'Ada', roles: ['admin', 'user'], active: true, meta: { since: 2024 } },
  null,
  2,
);

export default function JsonYamlTool({ initialInput }: ToolComponentProps) {
  return (
    <BiConverter
      definition={getDefinition('json-yaml')!}
      leftLabel="JSON"
      rightLabel="YAML"
      leftLanguage="json"
      rightLanguage="yaml"
      forward={jsonToYaml}
      backward={yamlToJson}
      example={EXAMPLE}
      initialInput={initialInput}
      createWorker={() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })}
    />
  );
}
