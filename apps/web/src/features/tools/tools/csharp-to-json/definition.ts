// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-to-json/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'csharp-to-json',
  name: 'C# ↔ JSON',
  description: 'Generate sample JSON from C# classes (loose mode) or generate C# DTOs from JSON.',
  category: 'dotnet',
  keywords: [
    'csharp',
    'c#',
    'class',
    'model',
    'json',
    'dto',
    'poco',
    'record',
    'serialize',
    'generate',
  ],
  tags: ['converter', 'dotnet'],
  execution: 'local',
  inputType: 'json',
  outputType: 'json',
  popular: true,
});
