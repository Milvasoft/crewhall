// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-text-drawer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'ascii-text-drawer',
  name: 'ASCII Art Text',
  description: 'Turn text into ASCII-art banners with a choice of figlet fonts, locally.',
  category: 'text',
  keywords: ['ascii', 'art', 'figlet', 'banner', 'text', 'font', 'big text', 'drawer'],
  tags: ['generator'],
  execution: 'local',
  inputType: 'text',
});
