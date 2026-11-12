// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/password-strength-analyser/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'password-strength-analyser',
  name: 'Password Strength Analyser',
  description: "Estimate a password's entropy and crack time from its character sets, locally.",
  category: 'security',
  keywords: [
    'password',
    'strength',
    'entropy',
    'crack',
    'time',
    'analyze',
    'analyser',
    'secure',
    'bits',
  ],
  tags: ['security'],
  execution: 'local',
});
