// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-parser/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'url-parser',
  name: 'URL Parser',
  description: 'Break a URL into protocol, host, path, query parameters and fragment, locally.',
  category: 'web',
  keywords: ['url', 'uri', 'parse', 'query', 'params', 'querystring', 'host', 'path'],
  tags: ['parser'],
  execution: 'local',
  inputType: 'url',
  outputType: 'json',
});
