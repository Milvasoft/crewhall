// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/numeronym-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'numeronym-generator',
  name: 'Numeronym Generator',
  description: 'Shorten words like "internationalization" to numeronyms like "i18n", locally.',
  category: 'text',
  keywords: ['numeronym', 'i18n', 'a11y', 'l10n', 'abbreviation', 'shorten', 'acronym'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
