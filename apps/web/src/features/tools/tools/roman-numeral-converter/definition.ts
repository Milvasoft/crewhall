// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/roman-numeral-converter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'roman-numeral-converter',
  name: 'Roman Numeral Converter',
  description: 'Convert between integers (1–3999) and Roman numerals, locally.',
  category: 'devutils',
  keywords: ['roman', 'numeral', 'number', 'convert', 'converter', 'latin', 'arabic'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
