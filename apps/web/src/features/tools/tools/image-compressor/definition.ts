// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/image-compressor/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'image-compressor',
  name: 'Image Compressor',
  description: 'Resize and compress images to JPEG/WebP/PNG in your browser, nothing is uploaded.',
  category: 'images',
  keywords: ['image', 'compress', 'resize', 'optimize', 'jpeg', 'webp', 'png', 'shrink'],
  tags: ['image'],
  execution: 'local',
  inputType: 'image',
  outputType: 'image',
  popular: true,
});
