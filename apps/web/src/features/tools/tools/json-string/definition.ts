// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-string/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-string',
  name: 'JSON ↔ String',
  description:
    'Stringify JSON into an escaped string literal for code, or parse a string back to JSON, locally.',
  category: 'json',
  keywords: [
    'json',
    'string',
    'stringify',
    'escape',
    'unescape',
    'parse',
    'minify',
    'json to string',
    'code',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'json',
  outputType: 'text',
});
