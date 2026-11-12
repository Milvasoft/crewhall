// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-viewer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'json-viewer',
  name: 'JSON Viewer & Beautifier',
  description: 'Format, minify, sort and validate JSON locally, with precise error locations.',
  category: 'json',
  keywords: ['json', 'beautify', 'format', 'pretty', 'minify', 'validate', 'viewer', 'prettify'],
  execution: 'local',
  inputType: 'json',
  outputType: 'json',
  popular: true,
});
