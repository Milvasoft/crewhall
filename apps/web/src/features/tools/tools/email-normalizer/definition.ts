// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/email-normalizer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'email-normalizer',
  name: 'Email Normalizer',
  description:
    'Reduce emails to a canonical form (Gmail dots and +tags) to spot duplicates, locally.',
  category: 'web',
  keywords: ['email', 'normalize', 'canonical', 'gmail', 'dedupe', 'plus', 'subaddress', 'dots'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
});
