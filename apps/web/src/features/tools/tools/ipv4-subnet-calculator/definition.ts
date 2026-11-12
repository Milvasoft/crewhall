// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-subnet-calculator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'ipv4-subnet-calculator',
  name: 'IPv4 Subnet Calculator',
  description:
    'Compute network, broadcast, netmask, host range and host count from a CIDR, locally.',
  category: 'network',
  keywords: [
    'ipv4',
    'subnet',
    'cidr',
    'netmask',
    'network',
    'broadcast',
    'wildcard',
    'hosts',
    'calculator',
    'vlsm',
  ],
  tags: ['network'],
  execution: 'local',
});
