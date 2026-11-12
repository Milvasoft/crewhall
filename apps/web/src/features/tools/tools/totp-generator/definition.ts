// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/totp-generator/definition.ts. See THIRD_PARTY.md.
import { defineTool } from '@/features/tools/lib/tool-sdk';

export default defineTool({
  id: 'totp-generator',
  name: 'TOTP Generator & Validator',
  description:
    'Generate time-based one-time codes (RFC 6238) from a secret, with a QR code and validator, locally.',
  category: 'security',
  keywords: [
    'totp',
    'otp',
    '2fa',
    'mfa',
    'authenticator',
    'one-time',
    'code',
    'hotp',
    'rfc6238',
    'google authenticator',
  ],
  tags: ['security', 'generator'],
  execution: 'local',
});
