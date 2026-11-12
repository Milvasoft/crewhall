// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv6-ula-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'ipv6-ula-generator',
  name: 'IPv6 ULA Generator',
  description:
    'Generate a random RFC 4193 Unique Local Address prefix (fd00::/8) with subnet, locally.',
  category: 'network',
  keywords: [
    'ipv6',
    'ula',
    'unique local',
    'rfc4193',
    'fd00',
    'prefix',
    'subnet',
    'generator',
    'private',
  ],
  tags: ['network', 'generator'],
  execution: 'local',
});
