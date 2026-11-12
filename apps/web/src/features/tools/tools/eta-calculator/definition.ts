// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/eta-calculator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'eta-calculator',
  name: 'ETA Calculator',
  description: 'Estimate how long a task takes and when it finishes from a measured rate, locally.',
  category: 'devutils',
  keywords: [
    'eta',
    'estimate',
    'time',
    'arrival',
    'duration',
    'rate',
    'progress',
    'download',
    'finish',
  ],
  tags: ['converter'],
  execution: 'local',
});
