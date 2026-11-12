import type { Db } from '@crewhall/db';
import type { GatewayHooks } from '../../realtime/gateway';
import { loadConversation, memberIds, membershipOf } from './access';
import { CHAT_EVENT_TYPES, chatEnabled, chatEnabledCached } from './module';
import { inLiveMeeting } from '../meet/presence';
import { statusChoice } from './status';

/** What the WebSocket gateway needs from chat: typing, saved status, the module switch. */
export function gatewayHooks(db: Db): GatewayHooks {
  return {
    async typingRecipients(orgId, userId, conversationId) {
      if (!(await chatEnabled(db, orgId))) return null;
      const conv = await loadConversation(db, orgId, conversationId).catch(() => null);
      if (!conv || conv.archivedAt) return null;
      const m = await membershipOf(db, conv, userId);
      if (!m.isMember) return null;
      return memberIds(db, conv);
    },
    statusChoice: (orgId, userId) => statusChoice(db, orgId, userId),
    inMeeting: (orgId, userId) => inLiveMeeting(db, orgId, userId),
    prime: async (orgId) => {
      await chatEnabled(db, orgId);
    },
    allows: (orgId, event) => !CHAT_EVENT_TYPES.has(event.type) || chatEnabledCached(db, orgId),
  };
}
