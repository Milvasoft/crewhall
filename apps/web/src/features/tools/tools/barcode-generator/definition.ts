// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/barcode-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'barcode-generator',
  name: 'Barcode Generator',
  description: 'Generate barcodes (Code128, EAN, UPC, Code39 and more) from text, locally.',
  category: 'images',
  keywords: ['barcode', 'code128', 'ean', 'upc', 'code39', 'generator', 'svg', 'png'],
  tags: ['image', 'generator'],
  execution: 'local',
  inputType: 'text',
  outputType: 'image',
});
