// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-toml/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { jsonToToml, tomlToJson } from './logic';

const EXAMPLE = JSON.stringify(
  {
    title: 'Crewhall',
    owner: { name: 'Ada', roles: ['admin', 'user'] },
    server: { host: 'localhost', ports: [80, 443], enabled: true },
  },
  null,
  2,
);

export default function JsonTomlTool({ initialInput }: ToolComponentProps) {
  return (
    <BiConverter
      definition={getDefinition('json-toml')!}
      leftLabel="JSON"
      rightLabel="TOML"
      leftLanguage="json"
      forward={jsonToToml}
      backward={tomlToJson}
      example={EXAMPLE}
      initialInput={initialInput}
    />
  );
}
