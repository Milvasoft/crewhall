// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/phone-parser/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'phone-parser',
  name: 'Phone Parser & Formatter',
  description: 'Parse a phone number into country, type and E.164, and format it, locally.',
  category: 'data',
  keywords: [
    'phone',
    'number',
    'parse',
    'format',
    'e164',
    'international',
    'country',
    'msisdn',
    'telephone',
  ],
  tags: ['parser'],
  execution: 'local',
  inputType: 'text',
});
