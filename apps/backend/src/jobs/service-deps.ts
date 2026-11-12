import type { Deps } from '../deps';
import type { PresenceReader, PresenceTracker } from '../realtime/presence';
import type { JobDeps } from './handlers';

/** The worker has no WebSocket connections: nobody is online there (as in mcp/approvals). */
const NOBODY_ONLINE: PresenceReader & Pick<PresenceTracker, 'setMeeting' | 'setScreenShare'> = {
  hasFocusedSession: () => false,
  isConnected: () => false,
  onlineUserIds: () => [],
  // The worker has no connections; the api's own webhook keeps "Toplantıda" current.
  setMeeting: () => undefined,
  setScreenShare: () => undefined,
};

/** Services written for requests, called from a job (no auth, nobody online). */
export function serviceDeps(deps: JobDeps): Deps {
  return {
    ...deps,
    auth: undefined as never,
    setupToken: null,
    presence: NOBODY_ONLINE as PresenceTracker,
  };
}
