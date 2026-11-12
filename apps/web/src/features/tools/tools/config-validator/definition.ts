// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/config-validator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'config-validator',
  name: 'Config Validator',
  description:
    'Validate YAML, Docker Compose and Kubernetes manifests for structure and common mistakes, locally.',
  category: 'web',
  keywords: [
    'yaml',
    'validator',
    'docker',
    'docker compose',
    'kubernetes',
    'k8s',
    'manifest',
    'lint',
    'devops',
  ],
  tags: ['validator', 'devops'],
  execution: 'local',
  inputType: 'yaml',
  outputType: 'text',
});
