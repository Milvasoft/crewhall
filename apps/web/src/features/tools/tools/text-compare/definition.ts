// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-compare/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'text-compare',
  name: 'Text Compare',
  description: 'Diff two blocks of text side by side, locally, with whitespace and case options.',
  category: 'text',
  keywords: ['diff', 'compare', 'difference', 'text', 'merge', 'changes'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
  popular: true,
});
