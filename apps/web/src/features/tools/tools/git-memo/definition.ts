// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/git-memo/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'git-memo',
  name: 'Git Cheatsheet',
  description: 'A searchable memo of the git commands you keep forgetting, locally.',
  category: 'devutils',
  keywords: ['git', 'cheatsheet', 'memo', 'commands', 'reference', 'rebase', 'stash', 'reset'],
  tags: ['reference'],
  execution: 'local',
});
