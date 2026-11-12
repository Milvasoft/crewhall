// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/regex-tester/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'regex-tester',
  name: 'Regex Tester',
  description:
    'Test JavaScript regular expressions against sample text with live matches, groups and replace.',
  category: 'devutils',
  keywords: ['regex', 'regexp', 'regular expression', 'match', 'pattern', 'replace'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
  popular: true,
});
