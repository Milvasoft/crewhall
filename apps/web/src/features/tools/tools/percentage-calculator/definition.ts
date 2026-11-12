// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/percentage-calculator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'percentage-calculator',
  name: 'Percentage Calculator',
  description: 'Percent of a value, what-percent-of, and percentage change — all in one, locally.',
  category: 'devutils',
  keywords: [
    'percentage',
    'percent',
    'calculator',
    'increase',
    'decrease',
    'change',
    'ratio',
    'math',
  ],
  tags: ['converter'],
  execution: 'local',
});
