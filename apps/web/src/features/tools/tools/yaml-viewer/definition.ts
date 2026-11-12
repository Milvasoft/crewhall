// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/yaml-viewer/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'yaml-viewer',
  name: 'YAML Viewer & Formatter',
  description: 'Validate and pretty-print YAML, optionally sort keys, or view it as JSON, locally.',
  category: 'data',
  keywords: [
    'yaml',
    'viewer',
    'format',
    'prettify',
    'validate',
    'lint',
    'beautify',
    'sort',
    'json',
  ],
  tags: ['formatter'],
  execution: 'local',
  inputType: 'yaml',
  outputType: 'yaml',
});
