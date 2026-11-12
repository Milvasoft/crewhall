// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/html-markdown/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'html-markdown',
  name: 'HTML → Markdown',
  description: 'Convert HTML into clean Markdown, locally in your browser.',
  category: 'text',
  keywords: ['html', 'markdown', 'convert', 'turndown', 'md'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'html',
  outputType: 'markdown',
});
