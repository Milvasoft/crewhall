// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/markdown-viewer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'markdown-viewer',
  name: 'Markdown Viewer',
  description:
    'Write Markdown and preview sanitized HTML side by side, rendered locally and safely.',
  category: 'text',
  keywords: ['markdown', 'md', 'preview', 'html', 'render', 'readme', 'gfm'],
  execution: 'local',
  inputType: 'markdown',
  outputType: 'html',
});
