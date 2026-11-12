import { Icon, IconButton, Tooltip } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Conversation } from '@/lib/chat/types';
import { api, idempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { meetKeys } from '@/lib/meet/queries';
import { usePermissions } from '@/lib/session';
import { useFail } from './bits';
import { LiveInConversation, useConversationLive } from './CallButton';
import { useOpenMeeting } from './openMeeting';

/**
 * Conversations a meeting is started from (design 13.12): space chats. Direct and group chats
 * call instead (CallButton, H7); meeting, alert and card chats have their own.
 */
const STARTABLE: ReadonlySet<Conversation['type']> = new Set(['space']);

/**
 * "Toplantı başlat" in the chat header: an instant meeting tied to the conversation (one room
 * per conversation, reused while it runs). Hidden while the meet module is off.
 */
export function StartMeetingButton({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const openMeeting = useOpenMeeting();
  const fail = useFail();
  const { role } = usePermissions();
  const meetOn = useModuleEnabled('meet');
  const start = useMutation({
    mutationFn: () =>
      api.call('createMeeting', {
        body: { mode: 'instant', conversationId: conv.id },
        idempotencyKey: idempotencyKey(),
      }),
    onSuccess: async (m) => {
      await qc.invalidateQueries({ queryKey: meetKeys.all });
      openMeeting(m.slug);
    },
    onError: fail,
  });

  const shown = meetOn && role !== 'guest' && !conv.archivedAt && STARTABLE.has(conv.type);
  const live = useConversationLive(conv, shown);
  if (!shown) return null;
  // A meeting going on in the space chat: join it instead of starting one.
  if (live) return <LiveInConversation conv={conv} live={live} />;
  return (
    <Tooltip content={t('meet.actions.startInChat')}>
      <IconButton
        size="sm"
        tone="plain"
        aria-label={t('meet.actions.startInChat')}
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        <Icon name="video" size={17} />
      </IconButton>
    </Tooltip>
  );
}
