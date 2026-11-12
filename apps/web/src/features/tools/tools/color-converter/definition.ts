// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/color-converter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'color-converter',
  name: 'Color Converter',
  description: 'Convert colors between hex, rgb(a) and hsl(a), with a live swatch, locally.',
  category: 'web',
  keywords: [
    'color',
    'colour',
    'hex',
    'rgb',
    'rgba',
    'hsl',
    'hsla',
    'convert',
    'converter',
    'css',
    'swatch',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
