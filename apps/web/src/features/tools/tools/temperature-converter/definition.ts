// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/temperature-converter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'temperature-converter',
  name: 'Temperature Converter',
  description: 'Convert temperatures between Celsius, Fahrenheit, Kelvin and Rankine, locally.',
  category: 'devutils',
  keywords: [
    'temperature',
    'celsius',
    'fahrenheit',
    'kelvin',
    'rankine',
    'convert',
    'converter',
    'degrees',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
