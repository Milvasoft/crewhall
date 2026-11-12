// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/safelink-decoder/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'safelink-decoder',
  name: 'SafeLink Decoder',
  description:
    'Unwrap Outlook SafeLinks and similar redirect URLs to reveal the real destination, locally.',
  category: 'web',
  keywords: [
    'safelink',
    'safe link',
    'outlook',
    'atp',
    'redirect',
    'unwrap',
    'decode',
    'url',
    'phishing',
  ],
  tags: ['parser'],
  execution: 'local',
  inputType: 'url',
  outputType: 'url',
});
