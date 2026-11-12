import { eq } from 'drizzle-orm';
import { users } from '@crewhall/db';
import type { NotificationCategory, PageNotificationType } from '@crewhall/shared';
import type { Logger } from '../../logger';
import { isModuleEnabled } from '../identity/modules';
import { notify, type NotificationInput, type NotifyDeps } from '../notifications/notify';

/**
 * Wiki notifications (doc 17 §10 "@mention (chat, sayfa yorumu, kart)", design 5.6, 5.9).
 * The wiki hands notices to this hook; each process (api, worker) wires the notification
 * centre with `setPageNotifier(pageNotifier(deps))`. Until then notices are only logged.
 */
export interface PageNotice {
  /** The export job sends `page.export_ready` to the notification centre itself. */
  type: Exclude<PageNotificationType, 'page.export_ready'>;
  orgId: string;
  spaceId: string;
  nodeId: string;
  pageName: string;
  actorId: string | null;
  userIds: string[];
  commentId?: string;
  /** Root comment of the thread, for replies and the comment's own grouping. */
  threadId?: string;
  excerpt?: string;
  /** Web path that opens the page (and the comment). */
  url: string;
}

export type PageNotifier = (notice: PageNotice, logger: Logger) => Promise<void>;

const logOnly: PageNotifier = async (notice, logger) => {
  logger.info(
    { type: notice.type, nodeId: notice.nodeId, users: notice.userIds.length },
    'page notification (no notification service wired)',
  );
};

let notifier: PageNotifier = logOnly;

export function setPageNotifier(next: PageNotifier | null) {
  notifier = next ?? logOnly;
}

const CATEGORY: Record<PageNotice['type'], NotificationCategory> = {
  'page.mention': 'mention',
  'page.comment_mention': 'mention',
  'page.comment_reply': 'direct_reply',
  // A restore replaced what these people wrote: a change to shared content.
  'page.restored': 'share',
  'page.updated': 'share',
};

/** Rows of one notice for the notification centre (bell, push, digest). */
export function noticeInputs(notice: PageNotice, actorName: string | null): NotificationInput[] {
  const data: NotificationInput['data'] = {
    // `name` / `actorName` are what push texts and the e-mail digest read.
    name: notice.pageName,
    actorName,
    ...(notice.excerpt ? { excerpt: notice.excerpt } : {}),
  };
  return notice.userIds.map((userId) => ({
    orgId: notice.orgId,
    userId,
    type: notice.type,
    category: CATEGORY[notice.type],
    actorId: notice.actorId,
    target: { type: 'node', id: notice.nodeId, spaceId: notice.spaceId },
    data,
    url: notice.url,
    // Several replies in one thread stay one unread row ("3 yeni yanıt").
    groupKey:
      notice.type === 'page.comment_reply' && notice.threadId
        ? `page.comment_reply:${notice.threadId}`
        : notice.type === 'page.updated'
          ? `page.updated:${notice.nodeId}`
          : null,
  }));
}

/** The notification centre as the wiki's notifier; nothing is sent while the wiki is off. */
export function pageNotifier(deps: NotifyDeps): PageNotifier {
  return async (notice) => {
    if (!(await isModuleEnabled(deps.db, notice.orgId, 'wiki'))) return;
    let actorName: string | null = null;
    if (notice.actorId) {
      const [actor] = await deps.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, notice.actorId));
      actorName = actor?.name ?? null;
    }
    await notify(deps, noticeInputs(notice, actorName));
  };
}

export async function sendPageNotice(notice: PageNotice, logger: Logger) {
  const userIds = [...new Set(notice.userIds)].filter((id) => id !== notice.actorId);
  if (!userIds.length) return;
  try {
    await notifier({ ...notice, userIds }, logger);
  } catch (err) {
    logger.warn({ err, nodeId: notice.nodeId }, 'page notification failed');
  }
}
