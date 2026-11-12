// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/iban-validator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'iban-validator',
  name: 'IBAN Validator & Parser',
  description:
    "Validate an IBAN's checksum and break it into country, check digits and BBAN, locally.",
  category: 'data',
  keywords: ['iban', 'bank', 'account', 'validate', 'parser', 'checksum', 'mod97', 'bban', 'sepa'],
  tags: ['parser'],
  execution: 'local',
  inputType: 'text',
});
