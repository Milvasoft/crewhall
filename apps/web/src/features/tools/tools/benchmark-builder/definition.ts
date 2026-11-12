// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/benchmark-builder/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'benchmark-builder',
  name: 'Benchmark Builder',
  description:
    'Compare timing samples across suites by mean and variance, then export the results, locally.',
  category: 'devutils',
  keywords: [
    'benchmark',
    'compare',
    'performance',
    'mean',
    'variance',
    'timing',
    'measure',
    'suite',
  ],
  tags: ['reference'],
  execution: 'local',
});
