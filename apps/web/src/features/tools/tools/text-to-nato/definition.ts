// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-nato/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'text-to-nato',
  name: 'Text to NATO Alphabet',
  description: 'Spell text using the NATO phonetic alphabet (Alfa, Bravo, Charlie…), locally.',
  category: 'text',
  keywords: [
    'nato',
    'phonetic',
    'alphabet',
    'spell',
    'alfa',
    'bravo',
    'charlie',
    'military',
    'radio',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
