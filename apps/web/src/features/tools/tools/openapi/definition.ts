// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/openapi/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'openapi',
  name: 'OpenAPI Viewer',
  description:
    'Explore an OpenAPI/Swagger spec (JSON or YAML) and generate C# models from its schemas, locally.',
  category: 'web',
  keywords: ['openapi', 'swagger', 'api', 'spec', 'viewer', 'csharp', 'models', 'schema', 'rest'],
  tags: ['viewer', 'dotnet'],
  execution: 'local',
  inputType: 'json',
  outputType: 'text',
});
