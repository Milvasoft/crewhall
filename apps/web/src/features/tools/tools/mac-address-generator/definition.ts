// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'mac-address-generator',
  name: 'MAC Address Generator',
  description:
    'Generate random MAC addresses with a chosen separator, case and optional OUI prefix, locally.',
  category: 'network',
  keywords: ['mac', 'address', 'generator', 'random', 'oui', 'ethernet', 'hardware', 'hwaddr'],
  tags: ['network', 'generator'],
  execution: 'local',
});
