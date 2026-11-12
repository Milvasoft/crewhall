// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-length/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'string-length',
  name: 'String Length & Stats',
  description: 'Count characters, words, lines and UTF-8 bytes in text, computed locally.',
  category: 'text',
  keywords: ['length', 'count', 'characters', 'words', 'bytes', 'size', 'lines'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
