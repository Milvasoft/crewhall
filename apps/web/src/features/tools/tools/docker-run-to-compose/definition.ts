// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/docker-run-to-compose/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'docker-run-to-compose',
  name: 'Docker Run to Compose',
  description: 'Convert a `docker run` command into a docker-compose service definition, locally.',
  category: 'devutils',
  keywords: [
    'docker',
    'run',
    'compose',
    'docker-compose',
    'convert',
    'converter',
    'yaml',
    'container',
    'devops',
  ],
  tags: ['converter', 'devops'],
  execution: 'local',
  outputType: 'yaml',
});
