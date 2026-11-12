// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-typescript/component.tsx. See THIRD_PARTY.md.
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { BiConverter } from '@/features/tools/components/tool/BiConverter';
import { csharpToTypeScript, typeScriptToCsharp } from './logic';

const EXAMPLE_CS = `public class User
{
    public string Name { get; set; }
    public int Age { get; set; }
    public List<string> Roles { get; set; }
    public DateTime CreatedAt { get; set; }
}`;

export default function CsharpTypeScriptTool({ initialInput }: ToolComponentProps) {
  return (
    <BiConverter
      definition={getDefinition('csharp-typescript')!}
      leftLabel="C#"
      rightLabel="TypeScript"
      forward={csharpToTypeScript}
      backward={typeScriptToCsharp}
      example={EXAMPLE_CS}
      initialInput={initialInput}
    />
  );
}
