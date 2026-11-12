// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/math-evaluator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'math-evaluator',
  name: 'Math Evaluator',
  description: 'Evaluate math expressions with functions and constants, locally (no eval).',
  category: 'devutils',
  keywords: [
    'math',
    'evaluate',
    'expression',
    'calculator',
    'compute',
    'arithmetic',
    'sqrt',
    'sin',
    'cos',
    'formula',
  ],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
});
