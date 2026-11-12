// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chronometer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'chronometer',
  name: 'Chronometer',
  description: 'A simple stopwatch with laps, running locally in your browser.',
  category: 'devutils',
  keywords: ['chronometer', 'stopwatch', 'timer', 'lap', 'time', 'clock'],
  tags: ['reference'],
  execution: 'local',
});
