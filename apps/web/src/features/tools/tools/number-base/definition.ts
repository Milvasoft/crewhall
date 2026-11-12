// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/number-base/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'number-base',
  name: 'Number Base Converter',
  description: 'Convert integers between hex, decimal, binary, octal and any base (2–36), locally.',
  category: 'devutils',
  keywords: [
    'base',
    'radix',
    'hex',
    'hexadecimal',
    'decimal',
    'binary',
    'octal',
    'number',
    'convert',
    'converter',
    '0x',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
