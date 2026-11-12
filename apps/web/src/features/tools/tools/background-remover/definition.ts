// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/background-remover/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'background-remover',
  name: 'Background Remover (color)',
  description:
    'Make a solid/near-solid background transparent by color, with tolerance and soft edges, locally.',
  category: 'images',
  keywords: [
    'background',
    'remove',
    'transparent',
    'chroma',
    'chroma key',
    'cutout',
    'png',
    'color key',
  ],
  tags: ['image'],
  execution: 'local',
  inputType: 'image',
  outputType: 'image',
  popular: true,
});
