// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/html-wysiwyg-editor/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'html-wysiwyg-editor',
  name: 'HTML WYSIWYG Editor',
  description: 'Write rich text with a toolbar and get clean HTML out, locally.',
  category: 'web',
  keywords: ['html', 'wysiwyg', 'editor', 'rich text', 'contenteditable', 'formatting', 'generate'],
  tags: ['editor'],
  execution: 'local',
  outputType: 'html',
});
