// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-typescript/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'csharp-typescript',
  name: 'C# ↔ TypeScript',
  description:
    'Generate TypeScript interfaces from C# models and C# classes from TypeScript, locally.',
  category: 'dotnet',
  keywords: [
    'csharp',
    'c#',
    'typescript',
    'ts',
    'interface',
    'model',
    'dto',
    'convert',
    'frontend',
  ],
  tags: ['converter', 'dotnet'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
