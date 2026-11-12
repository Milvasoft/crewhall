// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/id-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'id-generator',
  name: 'ID Generator',
  description: 'Generate GUIDs, UUID v4, time-sortable UUID v7 and ULIDs locally, in bulk.',
  category: 'security',
  keywords: ['guid', 'uuid', 'uuidv4', 'uuidv7', 'ulid', 'id', 'identifier', 'random', 'unique'],
  tags: ['generator', 'clipboard'],
  execution: 'local',
  outputType: 'text',
  popular: true,
});
