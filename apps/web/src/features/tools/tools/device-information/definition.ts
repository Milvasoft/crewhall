// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/device-information/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'device-information',
  name: 'Device Information',
  description:
    'See what your browser exposes: screen, viewport, platform, languages and more, locally.',
  category: 'web',
  keywords: [
    'device',
    'browser',
    'screen',
    'viewport',
    'platform',
    'info',
    'resolution',
    'user agent',
  ],
  tags: ['reference'],
  execution: 'local',
});
