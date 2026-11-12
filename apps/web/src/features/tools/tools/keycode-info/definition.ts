// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/keycode-info/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'keycode-info',
  name: 'Keycode Info',
  description:
    'Press any key to see its JavaScript event.key, code, keyCode and modifiers, locally.',
  category: 'web',
  keywords: ['keycode', 'key', 'code', 'keyboard', 'event', 'javascript', 'which', 'keydown'],
  tags: ['reference'],
  execution: 'local',
});
