import { can } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import type { ChatActor } from '../services/chat/access';
import { addRemoteMember, createRemoteConversation } from '../services/federation/chat';
import { conversationView } from '../services/chat/views';
import { FILES_PATH, serveFile } from '../services/federation/files';
import {
  endSharedFolder,
  listSharedFolders,
  serveFolderFile,
  shareFolder,
} from '../services/federation/folders';
import { joinSharedMeeting } from '../services/federation/meetings';
import {
  acceptSharedChannel,
  blockRemoteMember,
  declineSharedChannel,
  endSharedChannel,
  listConversationShares,
  listSharedChannels,
  shareChannel,
} from '../services/federation/shared';
import {
  DISCOVERY_PATH,
  INBOX_PATH,
  discoveryDocument,
  federationOn,
  ownDomain,
  postActivity,
  newActivity,
  rateAllowed,
  requireActivePeer,
  splitAddress,
} from '../services/federation/core';
import { handleOf } from '../services/federation/handles';
import { handleInbox, verifyPeerRequest } from '../services/federation/inbox';
import {
  addPeer,
  federationSettings,
  removePeer,
  updateFederation,
} from '../services/federation/peers';
import { shareNodeRemote } from '../services/federation/share';
import { primaryOrg } from '../services/brand';
import { orgContext } from '../services/membership';

function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

const chatActor = (ctx: Pick<OrgCtx<never>, 'org' | 'actor' | 'user'>): ChatActor => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
});

/** File requests one peer may make per minute (shared channels). */
const FILE_REQUESTS_PER_MINUTE = 300;

/** Federation (roadmap 26, docs/contracts/federasyon.md). */
export function registerFederation(r: Router): void {
  // ---- Admin ----
  r.org('getFederation', (ctx) => {
    requireAdmin(ctx);
    return federationSettings(ctx.deps, ctx.org);
  });
  r.org('updateFederation', (ctx) => {
    requireAdmin(ctx);
    return updateFederation(ctx.deps, ctx.org, ctx.body, ctx.user.id, ctx.req);
  });
  r.org('addFederationPeer', (ctx) => {
    requireAdmin(ctx);
    return addPeer(ctx.deps, ctx.org, ctx.body.domain, ctx.user.id, ctx.req);
  });
  r.org('removeFederationPeer', async (ctx) => {
    requireAdmin(ctx);
    await removePeer(ctx.deps, ctx.org, ctx.params.peerId, ctx.user.id, ctx.req);
    return {};
  });

  // ---- People ----
  r.org('getMyFederationAddress', async (ctx) => {
    if (!federationOn(ctx.org)) return { enabled: false, address: null };
    const handle = await handleOf(ctx.deps.db, ctx.org.id, ctx.user.id);
    return { enabled: true, address: handle ? `${handle}@${ownDomain(ctx.deps.env)}` : null };
  });
  r.org('lookupRemoteUser', async (ctx) => {
    if (ctx.actor.orgRole === 'guest') throw new AppError('federation_not_allowed');
    const { handle, domain } = splitAddress(ctx.query.address);
    await requireActivePeer(ctx.deps, ctx.org, domain);
    const answer = await postActivity(
      ctx.deps,
      ctx.org.id,
      domain,
      newActivity('user.lookup', { handle }),
    );
    if (typeof answer.name !== 'string') throw new AppError('federation_user_not_found');
    return { address: ctx.query.address, name: answer.name, domain };
  });
  r.org('createRemoteConversation', (ctx) =>
    createRemoteConversation(ctx.deps, chatActor(ctx), ctx.body.address),
  );
  r.org('addRemoteConversationMember', (ctx) =>
    addRemoteMember(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body.address),
  );
  r.org('shareNodeRemote', (ctx) =>
    shareNodeRemote(ctx.deps, chatActor(ctx), ctx.params.nodeId, ctx.body, ctx.req),
  );

  // ---- Shared channels ----
  r.org('listSharedChannels', (ctx) => listSharedChannels(ctx.deps, chatActor(ctx)));
  r.org('shareChannel', (ctx) =>
    shareChannel(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body.domain, ctx.req),
  );
  r.org('listConversationShares', (ctx) =>
    listConversationShares(ctx.deps, chatActor(ctx), ctx.params.conversationId),
  );
  r.org('acceptSharedChannel', (ctx) =>
    acceptSharedChannel(ctx.deps, chatActor(ctx), ctx.params.shareId, ctx.body),
  );
  r.org('declineSharedChannel', (ctx) =>
    declineSharedChannel(ctx.deps, chatActor(ctx), ctx.params.shareId),
  );
  r.org('endSharedChannel', (ctx) =>
    endSharedChannel(ctx.deps, chatActor(ctx), ctx.params.shareId),
  );
  r.org('listSharedFolders', (ctx) =>
    listSharedFolders(ctx.deps, chatActor(ctx), ctx.params.conversationId),
  );
  r.org('shareFolder', (ctx) =>
    shareFolder(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body.nodeId),
  );
  r.org('endSharedFolder', (ctx) =>
    endSharedFolder(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.params.folderId),
  );
  r.org('joinSharedMeeting', (ctx) =>
    joinSharedMeeting(ctx.deps, chatActor(ctx), ctx.params.conversationId),
  );
  r.org('blockRemoteMember', async (ctx) => {
    const a = chatActor(ctx);
    const conv = await blockRemoteMember(
      ctx.deps,
      a,
      ctx.params.conversationId,
      ctx.body.address,
      ctx.body.blocked,
    );
    return conversationView(ctx.deps.db, a, conv);
  });

  // ---- Installation to installation (signed, no session) ----
  r.rawPublic('GET', DISCOVERY_PATH, async ({ c, deps }) => {
    const org = await primaryOrg(deps.db);
    if (!org || !federationOn(org)) throw new AppError('not_found');
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(await discoveryDocument(deps, org));
  });
  r.rawPublic('POST', INBOX_PATH, async ({ c, deps }) => {
    const answer = await handleInbox(deps, {
      body: await c.req.text(),
      signatureInput: c.req.header('signature-input') ?? null,
      signature: c.req.header('signature') ?? null,
      contentType: c.req.header('content-type') ?? null,
      contentDigest: c.req.header('content-digest') ?? null,
    });
    return c.json(answer);
  });
  r.rawPublic('POST', FILES_PATH, async ({ c, deps }) => {
    const { org, peer, json } = await verifyPeerRequest(
      deps,
      {
        body: await c.req.text(),
        signatureInput: c.req.header('signature-input') ?? null,
        signature: c.req.header('signature') ?? null,
        contentType: c.req.header('content-type') ?? null,
        contentDigest: c.req.header('content-digest') ?? null,
      },
      `${new URL(deps.env.API_URL).origin}${FILES_PATH}`,
    );
    if (!rateAllowed(`files:${org.id}:${peer.domain}`, FILE_REQUESTS_PER_MINUTE)) {
      throw new AppError('rate_limited', { reason: 'federation_files' });
    }
    const type = (json as { type?: unknown }).type;
    const file =
      type === 'folder.file.get'
        ? await serveFolderFile(deps, org, peer, json)
        : await serveFile(deps, org, peer.id, json);
    return c.body(new Uint8Array(file.content), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.content.length),
      'Cache-Control': 'no-store',
      // The type travels beside the bytes (the receiver's blob pipeline sniffs it again).
      'X-Crewhall-Mime': file.contentType,
    });
  });
}
