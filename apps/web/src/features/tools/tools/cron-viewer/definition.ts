// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/cron-viewer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'cron-viewer',
  name: 'Cron Viewer',
  description: 'Explain cron expressions in plain English and preview upcoming run times locally.',
  category: 'datetime',
  keywords: ['cron', 'crontab', 'schedule', 'quartz', 'hangfire', 'expression', 'next run'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
  popular: true,
});
