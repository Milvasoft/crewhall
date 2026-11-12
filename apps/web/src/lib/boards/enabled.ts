import { type Me } from '@crewhall/shared';
import { useMe } from '@/lib/session';

/** The org can turn boards (and drawings) off (`Me.modules`); a missing list means on. */
export function boardsEnabled(me: Pick<Me, 'modules'> | undefined): boolean {
  return !me?.modules || me.modules.includes('boards');
}

export function useBoardsEnabled(): boolean {
  return boardsEnabled(useMe());
}
