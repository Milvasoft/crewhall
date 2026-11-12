// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/xml-formatter/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'xml-formatter',
  name: 'XML Formatter',
  description: 'Pretty-print or minify XML, with validation, all local.',
  category: 'data',
  keywords: ['xml', 'format', 'beautify', 'prettify', 'minify', 'viewer', 'soap'],
  tags: ['formatter'],
  execution: 'local',
  inputType: 'xml',
  outputType: 'xml',
});
