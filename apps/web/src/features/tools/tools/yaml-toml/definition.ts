// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-toml/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'yaml-toml',
  name: 'YAML ↔ TOML',
  description: 'Convert YAML to TOML and TOML back to YAML, locally.',
  category: 'data',
  keywords: ['yaml', 'toml', 'convert', 'converter', 'config'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'yaml',
  outputType: 'toml',
});
