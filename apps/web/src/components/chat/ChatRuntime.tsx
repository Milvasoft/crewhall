import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useChatEnabled } from '@/lib/chat/enabled';
import { setGroupMentionLabels } from '@/lib/chat/names';
import { startChatRuntime } from '@/lib/chat/runtime';
import { armMessageSound, armNotificationSound } from '@/lib/chat/sound';
import { noteActivity } from '@/lib/chat/stores';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { StatusDialog } from './StatusDialog';

/**
 * Mounted once in the signed-in shell: opens /ws, keeps chat caches, presence and the bell
 * current on every screen (not only in chat), and tracks activity for "away".
 */
export function ChatRuntime() {
  const qc = useQueryClient();
  const { t } = useI18n();
  const userId = useMe()?.user.id;
  const chat = useChatEnabled();

  useEffect(() => {
    setGroupMentionLabels({ all: t('chat.mention.all'), here: t('chat.mention.here') });
  }, [t]);

  useEffect(() => {
    if (!userId) return;
    return startChatRuntime(qc, userId, { chat });
  }, [qc, userId, chat]);

  // Browsers allow sound only after an interaction: the first click or key unlocks it.
  useEffect(() => armMessageSound(), []);

  // Desktop app: its native chat notifications are silent and chime here (lib/chat/sound).
  useEffect(() => (userId ? armNotificationSound(qc, userId) : undefined), [qc, userId]);

  useEffect(() => {
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, noteActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, noteActivity));
  }, []);

  return <StatusDialog />;
}
