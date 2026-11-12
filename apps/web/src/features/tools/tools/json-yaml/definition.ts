// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-yaml/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-yaml',
  name: 'JSON ↔ YAML',
  description: 'Convert JSON to YAML and YAML back to JSON, locally, both ways.',
  category: 'json',
  keywords: ['json', 'yaml', 'yml', 'convert', 'config'],
  tags: ['converter', 'formatter'],
  execution: 'local',
  inputType: 'json',
  outputType: 'yaml',
});
