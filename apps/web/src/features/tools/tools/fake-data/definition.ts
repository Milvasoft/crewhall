// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/fake-data/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'fake-data',
  name: 'Fake Data Generator',
  description:
    'Generate realistic fake data from a field schema and export as JSON, CSV or SQL, locally.',
  category: 'data',
  keywords: [
    'fake',
    'mock',
    'test data',
    'seed',
    'generator',
    'json',
    'csv',
    'sql',
    'faker',
    'dummy',
  ],
  tags: ['generator'],
  execution: 'local',
  outputType: 'json',
  popular: true,
});
