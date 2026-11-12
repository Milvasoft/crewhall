// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/appsettings-env/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'appsettings-env',
  name: 'appsettings.json ↔ Environment Variables',
  description:
    'Convert .NET appsettings.json to environment variables (and back) for Docker, Kubernetes and CI.',
  category: 'dotnet',
  keywords: [
    'appsettings',
    'env',
    'environment',
    'variables',
    'dotnet',
    '.net',
    'configuration',
    'docker',
    'kubernetes',
    'k8s',
    'double underscore',
    'connection string',
  ],
  tags: ['converter', 'dotnet', 'devops'],
  execution: 'local',
  inputType: 'json',
  outputType: 'text',
  popular: true,
});
