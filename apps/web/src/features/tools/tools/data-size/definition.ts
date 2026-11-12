// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/data-size/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'data-size',
  name: 'Data Size Converter',
  description: 'Convert between bytes, KB/MB/GB/TB, binary KiB/MiB/GiB and bits, locally.',
  category: 'devutils',
  keywords: [
    'data',
    'size',
    'byte',
    'bytes',
    'kb',
    'mb',
    'gb',
    'tb',
    'kib',
    'mib',
    'gib',
    'bit',
    'bits',
    'storage',
    'memory',
    'unit',
    'convert',
    'converter',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
