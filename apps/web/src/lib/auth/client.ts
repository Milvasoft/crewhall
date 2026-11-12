import { passkeyClient } from '@better-auth/passkey/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { config } from '@/config';

/**
 * better-auth client for /api/auth/*. The web uses the httpOnly session cookie.
 * Navigation after a 2FA redirect is handled by our screens, not by the plugin.
 */
export const authClient = createAuthClient({
  baseURL: `${config.apiUrl}/api/auth`,
  fetchOptions: { credentials: 'include' },
  // No organizationClient: org, member and invitation management goes through /api/v1 only.
  plugins: [twoFactorClient(), passkeyClient()],
});

export type AuthClient = typeof authClient;
