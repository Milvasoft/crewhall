// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/base64-image/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'base64-image',
  name: 'Base64 Image Viewer',
  description: 'Preview a Base64/data-URI image, or turn an image into a Base64 data URI, locally.',
  category: 'images',
  keywords: ['base64', 'image', 'data uri', 'preview', 'encode', 'decode', 'inline'],
  tags: ['image', 'converter'],
  execution: 'local',
  inputType: 'base64',
  outputType: 'text',
});
