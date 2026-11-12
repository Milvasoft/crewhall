import { type ConversationLive } from '@crewhall/shared';
import {
  Button,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type Conversation } from '@/lib/chat/types';
import { api, idempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { conversationLiveQuery } from '@/lib/meet/calls';
import { usePermissions } from '@/lib/session';
import { useNow } from '@/lib/useNow';
import { clock, useFail } from './bits';
import { useOpenMeeting } from './openMeeting';

/** Direct and group chats call (H7); space chats start a meeting (StartMeetingButton). */
export const CALLABLE: ReadonlySet<Conversation['type']> = new Set(['direct', 'group']);

function useStartCall(conv: Conversation) {
  const openMeeting = useOpenMeeting();
  const fail = useFail();
  return useMutation({
    mutationFn: (video: boolean) =>
      api.call('startCall', {
        body: { conversationId: conv.id, video },
        idempotencyKey: idempotencyKey(),
      }),
    onSuccess: (call) => openMeeting(call.slug, { call: call.id }),
    onError: fail,
  });
}

/** Whether a conversation's room has a call or a meeting going on (chat header). */
export function useConversationLive(conv: Conversation, enabled: boolean) {
  const data = useQuery({ ...conversationLiveQuery(conv.id), enabled }).data;
  return data && (data.call || data.meeting) ? data : null;
}

/**
 * "Sesli ara" and "Görüntülü ara" in the chat header (H7, Teams-like): each rings the other
 * members at once; the caller waits in the room until someone answers. While a call or a
 * meeting goes on in the conversation, "Sürüyor · Katıl" takes their place.
 */
export function CallButton({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const { role } = usePermissions();
  const meetOn = useModuleEnabled('meet');
  const shown = meetOn && role !== 'guest' && !conv.archivedAt && CALLABLE.has(conv.type);
  const start = useStartCall(conv);
  const live = useConversationLive(conv, shown);

  if (!shown) return null;
  if (live) return <LiveInConversation conv={conv} live={live} />;
  return (
    <>
      {/* A very narrow header (desktop window made small) folds the two into one "Ara" menu. */}
      <span className="hidden @max-[22rem]/chathead:flex">
        <Menu>
          <Tooltip content={t('meet.call.button')}>
            <MenuTrigger asChild>
              <IconButton
                size="sm"
                tone="plain"
                aria-label={t('meet.call.button')}
                disabled={start.isPending}
              >
                <Icon name="call" size={17} />
              </IconButton>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end">
            <MenuItem icon="call" onSelect={() => start.mutate(false)}>
              {t('meet.call.voice')}
            </MenuItem>
            <MenuItem icon="video" onSelect={() => start.mutate(true)}>
              {t('meet.call.video')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </span>
      <span className="flex items-center gap-1 @max-[22rem]/chathead:hidden">
        <Tooltip content={t('meet.call.voiceButton')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('meet.call.voiceButton')}
            disabled={start.isPending}
            onClick={() => start.mutate(false)}
          >
            <Icon name="call" size={17} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('meet.call.videoButton')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('meet.call.videoButton')}
            disabled={start.isPending}
            onClick={() => start.mutate(true)}
          >
            <Icon name="video" size={17} />
          </IconButton>
        </Tooltip>
      </span>
    </>
  );
}

/** "Sürüyor · 03:12 · Katıl": joins the call (or the room's meeting) going on. */
export function LiveInConversation({ conv, live }: { conv: Conversation; live: ConversationLive }) {
  const { t } = useI18n();
  const openMeeting = useOpenMeeting();
  const start = useStartCall(conv);
  const ringing = live.call?.status === 'ringing';
  const since = live.call?.answeredAt ?? live.meeting?.startedAt ?? live.call?.startedAt ?? null;
  const join = () => {
    // Starting a call where one goes on returns that call: the room opens on it.
    if (live.call) start.mutate(live.call.video);
    else if (live.meeting) openMeeting(live.meeting.slug);
  };
  return (
    <span className="flex items-center gap-2">
      <span
        role="status"
        className="flex h-8 items-center gap-1.5 rounded-full bg-success/15 px-2.5 text-xs font-semibold"
      >
        <span className="size-2 animate-pulse rounded-full bg-success" />
        <span className="max-sm:sr-only">
          {ringing ? t('meet.call.liveRinging') : <LiveFor since={since} />}
        </span>
      </span>
      <Button size="xs" variant="pri" disabled={start.isPending} onClick={join}>
        <Icon name={live.call?.video === false ? 'call' : 'video'} size={14} />
        {t('meet.actions.join')}
      </Button>
    </span>
  );
}

function LiveFor({ since }: { since: string | null }) {
  const { t } = useI18n();
  const now = useNow(1000);
  if (!since) return <>{t('meet.call.live')}</>;
  return <>{t('meet.call.liveFor', { duration: clock((now - Date.parse(since)) / 1000) })}</>;
}
