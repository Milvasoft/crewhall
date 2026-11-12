// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/code-formatter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'code-formatter',
  name: 'Code Formatter',
  description:
    'Format JavaScript, TypeScript, CSS, SCSS, HTML, JSON, YAML and Markdown with Prettier, locally.',
  category: 'web',
  keywords: [
    'prettier',
    'format',
    'beautify',
    'css',
    'html',
    'javascript',
    'typescript',
    'scss',
    'less',
    'code',
  ],
  tags: ['formatter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
  popular: true,
});
