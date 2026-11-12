// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/case-converter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'case-converter',
  name: 'Case Converter',
  description:
    'Convert text between camelCase, snake_case, kebab-case, PascalCase and more, locally.',
  category: 'text',
  keywords: [
    'case',
    'camel',
    'snake',
    'kebab',
    'pascal',
    'title',
    'constant',
    'upper',
    'lower',
    'slug',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
