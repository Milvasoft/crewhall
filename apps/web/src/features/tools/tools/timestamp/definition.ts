// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/timestamp/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'timestamp',
  name: 'Timestamp & Time Zone Converter',
  description: 'Convert Unix timestamps and dates across UTC, local and world time zones, locally.',
  category: 'datetime',
  keywords: [
    'timestamp',
    'unix',
    'epoch',
    'date',
    'time',
    'iso',
    'utc',
    'milliseconds',
    'seconds',
    'timezone',
    'time zone',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
