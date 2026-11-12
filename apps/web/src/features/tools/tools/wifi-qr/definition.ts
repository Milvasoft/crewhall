// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/wifi-qr/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'wifi-qr',
  name: 'WiFi QR Code Generator',
  description: 'Create a QR code that connects devices to a Wi-Fi network, locally.',
  category: 'images',
  keywords: ['wifi', 'qr', 'code', 'network', 'password', 'ssid', 'connect', 'generator'],
  tags: ['generator'],
  execution: 'local',
});
