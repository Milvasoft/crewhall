// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-toml/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { tomlToYaml, yamlToToml } from './logic';

const EXAMPLE = `title: Crewhall
owner:
  name: Ada
  roles:
    - admin
    - user
server:
  host: localhost
  ports:
    - 80
    - 443
  enabled: true
`;

export default function YamlTomlTool({ initialInput }: ToolComponentProps) {
  return (
    <BiConverter
      definition={getDefinition('yaml-toml')!}
      leftLabel="YAML"
      rightLabel="TOML"
      leftLanguage="yaml"
      forward={yamlToToml}
      backward={tomlToYaml}
      example={EXAMPLE}
      initialInput={initialInput}
    />
  );
}
