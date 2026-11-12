// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jsonpath/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'jsonpath',
  name: 'JSONPath Tester',
  description: 'Run JSONPath queries against a JSON document and inspect the matches, locally.',
  category: 'json',
  keywords: ['json', 'jsonpath', 'query', 'path', 'filter', 'xpath', 'select'],
  tags: ['query'],
  execution: 'local',
  inputType: 'json',
  outputType: 'json',
});
