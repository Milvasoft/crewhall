// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-diff/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-diff',
  name: 'JSON Diff',
  description:
    'Structurally compare two JSON documents and see added, removed and changed values, locally.',
  category: 'json',
  keywords: ['json', 'diff', 'compare', 'difference', 'changes', 'patch'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'json',
  outputType: 'json',
});
