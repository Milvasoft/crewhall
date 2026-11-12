// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/random-port/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'random-port',
  name: 'Random Port Generator',
  description: 'Pick random, unused-range TCP/UDP port numbers for local services, locally.',
  category: 'network',
  keywords: ['port', 'random', 'tcp', 'udp', 'generator', 'ephemeral', 'dev server'],
  tags: ['network', 'generator'],
  execution: 'local',
});
