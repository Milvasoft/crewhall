// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/emoji-picker/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'emoji-picker',
  name: 'Emoji Picker',
  description: 'Search emojis by name and copy the character, or its code points, locally.',
  category: 'text',
  keywords: ['emoji', 'picker', 'search', 'unicode', 'smiley', 'symbol', 'copy'],
  tags: ['reference'],
  execution: 'local',
});
