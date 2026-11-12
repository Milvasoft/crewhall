// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-unicode/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'text-to-unicode',
  name: 'Text to Unicode',
  description: 'Convert text to Unicode escapes (\\uXXXX, U+, HTML entities) and back, locally.',
  category: 'text',
  keywords: ['unicode', 'escape', 'codepoint', '\\u', 'u+', 'entity', 'html', 'encode', 'decode'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
