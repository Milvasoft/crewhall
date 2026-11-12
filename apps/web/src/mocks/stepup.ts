import { identityMockState } from './identity';
import { mcpMockState } from './mcp';
import { MockApiError, requireUser, type Resolvers } from './core';
import { newId } from './db';

const MIN = 60_000;

/**
 * Passkey step-up in mock mode: no authenticator, so the verify step accepts the stub
 * assertion of lib/identity/stepup.ts and opens both mock verification windows (identity,
 * MCP) like the server's single one.
 */
export const stepupResolvers: Resolvers<
  'getReauthMethods' | 'reauthPasskeyOptions' | 'reauthPasskeyVerify' | 'listDeviceKeys'
> = {
  getReauthMethods: ({ s }) => {
    const u = requireUser(s);
    const at = Math.max(identityMockState(s).verifiedAt, mcpMockState(s).verifiedAt);
    return {
      password: true,
      passkeys: u.passkeys.length,
      deviceKeys: [],
      verifiedUntil: at + 10 * MIN > Date.now() ? new Date(at + 10 * MIN).toISOString() : null,
    };
  },
  reauthPasskeyOptions: ({ s }) => {
    const u = requireUser(s);
    if (!u.passkeys.length) throw new MockApiError('not_found');
    return {
      challengeId: newId(),
      options: { challenge: 'mock', rpId: 'localhost', userVerification: 'required' },
    };
  },
  reauthPasskeyVerify: ({ s }) => {
    const u = requireUser(s);
    if (!u.passkeys.length) throw new MockApiError('identity_reauth_failed');
    const now = Date.now();
    identityMockState(s).verifiedAt = now;
    mcpMockState(s).verifiedAt = now;
    return { verifiedUntil: new Date(now + 10 * MIN).toISOString() };
  },
  listDeviceKeys: ({ s }) => {
    requireUser(s);
    return { items: [], nextCursor: null };
  },
};
