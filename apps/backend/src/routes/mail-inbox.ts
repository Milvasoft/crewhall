import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { audit } from '../services/audit';
import {
  addNote,
  createCanned,
  createInbox,
  deleteCanned,
  deleteInbox,
  deleteNote,
  getConversation,
  inboxTags,
  listCanned,
  listConversations,
  listInboxes,
  replyTo,
  setReplying,
  updateCanned,
  updateConversation,
  updateInbox,
  type InboxActor,
} from '../services/mail/inbox';

/** Shared inbox endpoints (sonraki-isler.md "Ortak gelen kutusu"); access is the space's. */
export function registerMailInbox(r: Router) {
  const actor = (ctx: Pick<OrgCtx<never>, 'actor' | 'org' | 'user'>): InboxActor => ({
    org: ctx.org,
    actor: ctx.actor,
    userId: ctx.user.id,
    userName: ctx.user.name,
  });

  r.org('mailInboxes', async (ctx) => ({ items: await listInboxes(ctx.deps.db, actor(ctx)) }));
  r.org(
    'mailCreateInbox',
    async (ctx) => {
      const inbox = await createInbox(ctx.deps, actor(ctx), ctx.body);
      await audit(
        ctx.deps.db,
        {
          orgId: ctx.org.id,
          actorId: ctx.user.id,
          action: 'mail.inbox.create',
          targetType: 'mail_inbox',
          targetId: inbox.id,
          meta: { email: inbox.email, spaceId: inbox.spaceId },
        },
        ctx.req,
      );
      return inbox;
    },
    { status: 201 },
  );
  r.org('mailUpdateInbox', async (ctx) => {
    const inbox = await updateInbox(ctx.deps, actor(ctx), ctx.params.inboxId, ctx.body);
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'mail.inbox.update',
        targetType: 'mail_inbox',
        targetId: inbox.id,
        meta: { password: ctx.body.password !== undefined },
      },
      ctx.req,
    );
    return inbox;
  });
  r.org('mailDeleteInbox', async (ctx) => {
    const l = await deleteInbox(ctx.deps, actor(ctx), ctx.params.inboxId);
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'mail.inbox.delete',
        targetType: 'mail_inbox',
        targetId: l.inbox.id,
        meta: { email: l.account.email },
      },
      ctx.req,
    );
    return {};
  });

  r.org('mailInboxConversations', async (ctx) =>
    listConversations(ctx.deps, actor(ctx), ctx.params.inboxId, ctx.query),
  );
  r.org('mailInboxConversation', async (ctx) =>
    getConversation(ctx.deps, actor(ctx), ctx.params.inboxId, ctx.params.conversationId, {
      remoteImages: ctx.query.remoteImages ?? false,
    }),
  );
  r.org('mailUpdateInboxConversation', async (ctx) =>
    updateConversation(
      ctx.deps,
      actor(ctx),
      ctx.params.inboxId,
      ctx.params.conversationId,
      ctx.body,
    ),
  );
  r.org(
    'mailAddInboxNote',
    async (ctx) =>
      addNote(ctx.deps, actor(ctx), ctx.params.inboxId, ctx.params.conversationId, ctx.body.body),
    { status: 201 },
  );
  r.org('mailDeleteInboxNote', async (ctx) => {
    await deleteNote(
      ctx.deps,
      actor(ctx),
      ctx.params.inboxId,
      ctx.params.conversationId,
      ctx.params.noteId,
    );
    return {};
  });
  r.org('mailInboxReplying', async (ctx) => {
    await setReplying(
      ctx.deps,
      actor(ctx),
      ctx.params.inboxId,
      ctx.params.conversationId,
      ctx.body.active,
    );
    return {};
  });
  r.org('mailInboxReply', async (ctx) =>
    replyTo(ctx.deps, actor(ctx), ctx.params.inboxId, ctx.params.conversationId, ctx.body),
  );
  r.org('mailInboxTags', async (ctx) => ({
    items: await inboxTags(ctx.deps.db, actor(ctx), ctx.params.inboxId),
  }));

  r.org('mailCannedResponses', async (ctx) => ({
    items: await listCanned(ctx.deps.db, actor(ctx), ctx.params.inboxId),
  }));
  r.org(
    'mailCreateCannedResponse',
    async (ctx) => createCanned(ctx.deps.db, actor(ctx), ctx.params.inboxId, ctx.body),
    { status: 201 },
  );
  r.org('mailUpdateCannedResponse', async (ctx) =>
    updateCanned(ctx.deps.db, actor(ctx), ctx.params.inboxId, ctx.params.cannedId, ctx.body),
  );
  r.org('mailDeleteCannedResponse', async (ctx) => {
    await deleteCanned(ctx.deps.db, actor(ctx), ctx.params.inboxId, ctx.params.cannedId);
    return {};
  });
}
