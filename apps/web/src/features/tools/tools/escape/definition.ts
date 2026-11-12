// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/escape/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'escape',
  name: 'Escape / Unescape',
  description: 'Escape or unescape text for C# strings, JSON, regex, URLs and HTML, locally.',
  category: 'dotnet',
  keywords: [
    'escape',
    'unescape',
    'csharp',
    'c#',
    'json',
    'regex',
    'url',
    'html',
    'entities',
    'backslash',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
