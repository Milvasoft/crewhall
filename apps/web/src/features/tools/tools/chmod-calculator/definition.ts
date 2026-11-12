// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chmod-calculator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'chmod-calculator',
  name: 'Chmod Calculator',
  description: 'Toggle Unix read/write/execute bits and get the octal and symbolic chmod, locally.',
  category: 'devutils',
  keywords: ['chmod', 'permissions', 'unix', 'linux', 'octal', 'symbolic', 'rwx', '755', 'file'],
  tags: ['converter'],
  execution: 'local',
});
