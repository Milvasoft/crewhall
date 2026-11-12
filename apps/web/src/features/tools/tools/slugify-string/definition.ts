// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/slugify-string/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'slugify-string',
  name: 'Slugify String',
  description: 'Turn text into a clean, URL-safe slug, stripping accents and punctuation, locally.',
  category: 'web',
  keywords: ['slug', 'slugify', 'url', 'permalink', 'kebab', 'seo', 'diacritics'],
  tags: ['converter'],
  execution: 'local',
  inputType: 'text',
  outputType: 'text',
});
