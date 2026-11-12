// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-range-expander/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'ipv4-range-expander',
  name: 'IPv4 Range Expander',
  description:
    'Find the smallest CIDR block that fully contains a start and end IPv4 address, locally.',
  category: 'network',
  keywords: ['ipv4', 'range', 'cidr', 'expand', 'block', 'supernet', 'aggregate', 'start', 'end'],
  tags: ['network'],
  execution: 'local',
});
