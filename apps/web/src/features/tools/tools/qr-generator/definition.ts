// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/qr-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'qr-generator',
  name: 'QR Code Generator',
  description:
    'Generate a QR code from text or a URL, with color and error-correction options, locally.',
  category: 'images',
  keywords: ['qr', 'qr code', 'generator', 'url', 'barcode', 'encode', 'png', 'svg'],
  tags: ['image', 'generator'],
  execution: 'local',
  inputType: 'text',
  outputType: 'image',
  popular: true,
});
