// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bip39-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'bip39-generator',
  name: 'BIP39 Mnemonic Generator',
  description: 'Generate and validate BIP39 recovery mnemonics with entropy and seed, locally.',
  category: 'security',
  keywords: [
    'bip39',
    'mnemonic',
    'seed',
    'phrase',
    'recovery',
    'wallet',
    'crypto',
    'entropy',
    'hd',
    'generator',
  ],
  tags: ['security', 'generator'],
  execution: 'local',
});
