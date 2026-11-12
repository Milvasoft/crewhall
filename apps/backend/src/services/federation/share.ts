import { randomUUID } from 'node:crypto';
import { resources } from '@crewhall/i18n';
import type { ShareNodeRemote, SharedRemote } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import type { ChatActor } from '../chat/access';
import { sendMessage } from '../chat/messages';
import { loadNode } from '../drive/access';
import { createShare } from '../drive/shares';
import { createRemoteConversation } from './chat';

/**
 * shareNodeRemote: a page or file goes to a remote person as a public link (with its usual
 * rights, expiry and audit) in our direct chat with them. The file itself stays here.
 */
export async function shareNodeRemote(
  deps: Deps,
  a: ChatActor,
  nodeId: string,
  input: ShareNodeRemote,
  req: RequestInfo,
): Promise<SharedRemote> {
  const access = await loadNode(deps.db, a, nodeId);
  // The chat first: an unknown person or a pending peer leaves no stray link behind.
  const conv = await createRemoteConversation(deps, a, input.address);
  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  const share = await createShare(
    deps,
    a,
    nodeId,
    { kind: 'link', role: 'viewer', expiresAt: expiresAt.toISOString(), allowDownload: true },
    req,
  );
  if (!share.url) throw new AppError('internal', { reason: 'share_url' });
  const t = resources[a.org.branding.defaultLocale === 'en' ? 'en' : 'tr'].email.federation;
  const name = access.node.name;
  const text = input.note
    ? t.shareWithNote
        .replace('{note}', input.note)
        .replace('{name}', name)
        .replace('{url}', share.url)
    : t.share.replace('{name}', name).replace('{url}', share.url);
  await sendMessage(deps, a, conv.id, { clientMsgId: randomUUID(), text, attachmentNodeIds: [] });
  await audit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'federation.share',
      targetType: 'node',
      targetId: nodeId,
      meta: { address: input.address, shareId: share.id, expiresAt },
    },
    req,
  );
  return { conversationId: conv.id, url: share.url, expiresAt: expiresAt.toISOString() };
}
