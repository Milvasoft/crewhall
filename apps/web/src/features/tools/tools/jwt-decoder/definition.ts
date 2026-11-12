// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jwt-decoder/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'jwt-decoder',
  name: 'JWT Decoder',
  description: "Decode a JSON Web Token's header and payload and inspect its claims, locally.",
  category: 'security',
  keywords: ['jwt', 'token', 'json web token', 'bearer', 'auth', 'claims', 'decode'],
  tags: ['parser', 'security'],
  execution: 'local',
  inputType: 'jwt',
  outputType: 'json',
  popular: true,
});
