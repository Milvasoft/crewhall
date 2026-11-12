// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-toml/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-toml',
  name: 'JSON ↔ TOML',
  description: 'Convert JSON to TOML and TOML back to JSON, locally.',
  category: 'data',
  keywords: ['json', 'toml', 'convert', 'converter', 'config', 'cargo'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'json',
  outputType: 'toml',
});
