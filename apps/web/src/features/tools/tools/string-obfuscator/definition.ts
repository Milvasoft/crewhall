// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-obfuscator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'string-obfuscator',
  name: 'String Obfuscator',
  description:
    'Mask the middle of a string (secrets, emails, tokens) keeping a few visible chars, locally.',
  category: 'text',
  keywords: ['obfuscate', 'mask', 'redact', 'hide', 'secret', 'censor', 'star', 'asterisk'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
