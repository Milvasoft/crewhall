// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-lookup/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'mac-address-lookup',
  name: 'MAC Address Lookup',
  description:
    'Find the vendor of a MAC address from a bundled set of common OUI prefixes, locally.',
  category: 'network',
  keywords: ['mac', 'address', 'lookup', 'oui', 'vendor', 'manufacturer', 'ethernet', 'hardware'],
  tags: ['network', 'reference'],
  execution: 'local',
});
