// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/user-agent-parser/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'user-agent-parser',
  name: 'User-Agent Parser',
  description: 'Break a User-Agent string into browser, engine, OS and device, locally.',
  category: 'web',
  keywords: [
    'user agent',
    'user-agent',
    'ua',
    'browser',
    'os',
    'device',
    'engine',
    'parse',
    'parser',
  ],
  tags: ['parser'],
  execution: 'local',
  inputType: 'text',
});
