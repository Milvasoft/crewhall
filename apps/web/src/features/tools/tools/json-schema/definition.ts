// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-schema/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-schema',
  name: 'JSON Schema',
  description:
    'Generate a JSON Schema from sample JSON, or validate JSON against a schema, locally.',
  category: 'json',
  keywords: ['json', 'schema', 'generate', 'validate', 'ajv', 'draft-07', 'validator'],
  tags: ['generator', 'validator'],
  execution: 'local',
  inputType: 'json',
  outputType: 'json',
});
