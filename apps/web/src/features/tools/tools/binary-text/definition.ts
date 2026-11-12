// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/binary-text/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'binary-text',
  name: 'Binary ↔ Text',
  description: 'Convert text to 8-bit binary and back, UTF-8 aware, entirely local.',
  category: 'encoding',
  keywords: ['binary', 'text', 'bits', 'utf-8', 'ascii', 'encode', 'decode', '0', '1', 'converter'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
