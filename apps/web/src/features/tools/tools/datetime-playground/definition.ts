// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/datetime-playground/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'datetime-playground',
  name: 'DateTime Playground',
  description: 'Explore dates: add/subtract, ISO week, day-of-year, leap year and diffs, locally.',
  category: 'datetime',
  keywords: [
    'datetime',
    'date',
    'time',
    'add',
    'subtract',
    'diff',
    'iso week',
    'day of year',
    'leap year',
  ],
  tags: ['reference'],
  execution: 'local',
  outputType: 'text',
});
