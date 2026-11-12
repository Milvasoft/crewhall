import { type Me } from '@crewhall/shared';
import { useMe } from '@/lib/session';

/** The org can turn chat off (`Me.modules`); a missing list means every module is on. */
export function chatEnabled(me: Pick<Me, 'modules'> | undefined): boolean {
  return !me?.modules || me.modules.includes('chat');
}

export function useChatEnabled(): boolean {
  return chatEnabled(useMe());
}
