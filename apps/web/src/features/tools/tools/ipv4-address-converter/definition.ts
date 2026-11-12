// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-address-converter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'ipv4-address-converter',
  name: 'IPv4 Address Converter',
  description:
    'Convert an IPv4 address between dotted-decimal, integer, hex, octal, binary and IPv6-mapped, locally.',
  category: 'network',
  keywords: [
    'ipv4',
    'ip',
    'address',
    'convert',
    'decimal',
    'integer',
    'hex',
    'octal',
    'binary',
    'ipv6',
    'mapped',
  ],
  tags: ['network', 'converter'],
  execution: 'local',
});
