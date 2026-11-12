import { def } from '../endpoint-def';
import { CreateOAuthHandoff, OAuthHandoff } from '../schemas/auth';

/** Connecting mail and calendar accounts from the app (schemas/auth.ts, OAuth hand-off). */
export const oauthEndpoints = {
  /**
   * The app (bearer session) asks for a one-time link for the system browser, bound to the
   * person, the org and the purpose. 403 when the person may not connect that kind of account.
   */
  createOAuthHandoff: def({
    method: 'POST',
    path: '/api/v1/me/oauth-handoffs',
    auth: 'session',
    body: CreateOAuthHandoff,
    response: OAuthHandoff,
  }),
};
