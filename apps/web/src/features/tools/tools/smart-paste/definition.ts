// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/smart-paste/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'smart-paste',
  name: 'Smart Paste',
  description:
    'Paste anything, it detects the format (JWT, JSON, SQL, XML…) and sends it to the right tool.',
  category: 'devutils',
  keywords: ['smart', 'paste', 'detect', 'identify', 'auto', 'recognize', 'what is this', 'format'],
  tags: ['reference'],
  execution: 'local',
  inputType: 'text',
  popular: true,
});
