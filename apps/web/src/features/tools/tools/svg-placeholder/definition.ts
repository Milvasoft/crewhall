// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/svg-placeholder/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'svg-placeholder',
  name: 'SVG Placeholder Generator',
  description: 'Generate lightweight placeholder images as inline SVG or a data URI, locally.',
  category: 'images',
  keywords: ['svg', 'placeholder', 'image', 'mock', 'dummy', 'data uri', 'generator'],
  tags: ['generator'],
  execution: 'local',
  outputType: 'image',
});
