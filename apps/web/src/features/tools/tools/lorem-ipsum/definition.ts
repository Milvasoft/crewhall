// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/lorem-ipsum/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'lorem-ipsum',
  name: 'Lorem Ipsum Generator',
  description: 'Generate placeholder text, words, sentences or paragraphs, locally.',
  category: 'text',
  keywords: ['lorem', 'ipsum', 'placeholder', 'dummy', 'filler', 'text', 'generator'],
  tags: ['generator'],
  execution: 'local',
  outputType: 'text',
});
