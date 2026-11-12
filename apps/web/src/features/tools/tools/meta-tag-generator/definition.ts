// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/meta-tag-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'meta-tag-generator',
  name: 'Meta Tag Generator',
  description: 'Generate SEO, OpenGraph and Twitter meta tags from a few fields, locally.',
  category: 'web',
  keywords: ['meta', 'tag', 'seo', 'opengraph', 'og', 'twitter', 'social', 'head', 'generator'],
  tags: ['generator'],
  execution: 'local',
  outputType: 'html',
});
