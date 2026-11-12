// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/query-string/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'query-string',
  name: 'Query String Builder',
  description: 'Build a URL query string from JSON parameters and parse one back to JSON, locally.',
  category: 'web',
  keywords: ['query', 'querystring', 'url', 'params', 'parameters', 'build', 'parse'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'json',
  outputType: 'text',
});
