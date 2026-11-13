import { useSyncExternalStore } from 'react';
import { type Conversation, type Message } from '@/lib/chat/types';

/** Chat dialogs opened from menus, rendered once by <ChatDialogs /> in the chat layout. */
export type ChatDialog =
  | { kind: 'rename'; conv: Conversation }
  | { kind: 'addPeople'; conv: Conversation }
  | { kind: 'addRemote'; conv: Conversation }
  | { kind: 'shareOrg'; conv: Conversation }
  | { kind: 'sharedFolders'; conv: Conversation }
  | { kind: 'members'; conv: Conversation }
  | { kind: 'linkSpace'; conv: Conversation }
  | { kind: 'privacy'; conv: Conversation }
  | { kind: 'leave'; conv: Conversation }
  | { kind: 'clear'; conv: Conversation }
  | { kind: 'deleteAll'; conv: Conversation }
  | { kind: 'deleteMessage'; message: Message; others: boolean }
  | { kind: 'forward'; message: Message }
  | { kind: 'messageInfo'; message: Message; conv: Conversation };

let current: ChatDialog | null = null;
const listeners = new Set<() => void>();

export function openChatDialog(d: ChatDialog | null): void {
  current = d;
  listeners.forEach((l) => l());
}

export function useChatDialog(): ChatDialog | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

// ---- "Durum ayarla" (19.15): opened from the rail avatar menu, Alt S or Ctrl K ----

let statusOpen = false;
const statusListeners = new Set<() => void>();

export function openStatusDialog(open: boolean): void {
  statusOpen = open;
  statusListeners.forEach((l) => l());
}

export function useStatusDialogOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => statusOpen,
    () => false,
  );
}
