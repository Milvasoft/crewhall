import { MICROSOFT_WEB_PATHS } from '@crewhall/shared';
import type * as TeamsModule from '@microsoft/teams-js';
import { saveTokens, type OfficeTokens } from './office';

/**
 * Teams JavaScript SDK (MIT), loaded on demand so the main bundle stays free of it. Outside
 * Teams (a plain tab, tests) `initialize` fails and the pages fall back to the browser.
 */
type TeamsSdk = typeof TeamsModule;
let sdk: Promise<TeamsSdk | null> | null = null;

export function loadTeams(): Promise<TeamsSdk | null> {
  sdk ??= import('@microsoft/teams-js')
    .then(async (m) => {
      await Promise.race([
        m.app.initialize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('not in Teams')), 3000)),
      ]);
      return m;
    })
    .catch(() => null);
  return sdk;
}

/** The Teams popup sign-in with the app's OIDC client; resolves once tokens are stored. */
export async function teamsSignIn(teams: TeamsSdk, clientId: string): Promise<boolean> {
  try {
    const result = await teams.authentication.authenticate({
      url: `${window.location.origin}${MICROSOFT_WEB_PATHS.officeSignIn}?client=${encodeURIComponent(clientId)}&host=teams`,
      width: 520,
      height: 640,
    });
    saveTokens(clientId, JSON.parse(result) as OfficeTokens);
    return true;
  } catch {
    return false;
  }
}
