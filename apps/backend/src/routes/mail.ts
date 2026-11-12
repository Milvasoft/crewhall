import {
  can,
  MAIL_RAW_PATHS,
  paths,
  withQuery,
  type EndpointName,
  type ResponseOf,
} from '@crewhall/shared';
import { z } from 'zod';
import { AppError } from '../http/errors';
import { requestInfo, type Router } from '../http/route';
import { appReturn } from '../services/oauth-handoff';
import type { OrgCtx } from '../http/types';
import { audit } from '../services/audit';
import { requireModule } from '../services/identity/modules';
import {
  accountState,
  connectOauth,
  connectPassword,
  disconnectAccount,
  imapOf,
  requireMailbox,
  updateAccount,
  type MailContext,
  type MailDeps,
} from '../services/mail/accounts';
import { getBulk, startBulk } from '../services/mail/bulk';
import { inboxMailbox, inboxSignInFinish, inboxSignInStart } from '../services/mail/inbox';
import { saveToDrive } from '../services/mail/drive';
import {
  deleteMessages,
  getMessage,
  getThread,
  listFolders,
  listMessages,
  moveMessages,
  readPart,
  updateFlags,
} from '../services/mail/messages';
import { finishOauth, startUrl } from '../services/mail/oauth';
import { testServers } from '../services/mail/probe';
import { suggestRecipients } from '../services/mail/recipients';
import { sendMessage } from '../services/mail/send';
import { timed, traced } from '../services/mail/timing';
import {
  requireSettings,
  settingsView,
  loadSettings,
  updateSettings,
} from '../services/mail/settings';
import { orgContext } from '../services/membership';

type Ctx = Pick<OrgCtx<never>, 'actor' | 'org'>;

function requireAdmin(ctx: Ctx) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

/**
 * Mailboxes belong to org members. Guests work only inside the spaces they were invited to,
 * and `org.view_directory` (every member has it) is the closest core action that excludes no
 * member; guests are refused here explicitly.
 */
function requireMailUser(ctx: Ctx) {
  if (
    ctx.actor.orgRole === 'guest' ||
    !can(ctx.actor, 'org.view_directory', { type: 'org', org: orgContext(ctx.org) })
  ) {
    throw new AppError('forbidden');
  }
}

const inboxActor = (ctx: Pick<OrgCtx<never>, 'actor' | 'org' | 'user'>) => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
  userName: ctx.user.name,
});

const driveActor = (ctx: Pick<OrgCtx<never>, 'actor' | 'org' | 'user'>) => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
  userName: ctx.user.name,
});

const AttachmentQuery = z.object({
  folder: z.string().min(1).max(1000),
  uid: z.coerce.number().int().min(1),
  part: z.string().min(1).max(50),
  inline: z.stringbool().optional(),
  inboxId: z.uuid().optional(),
});
const InboxOauthStartQuery = z.object({ inboxId: z.uuid() });
const OauthCallbackQuery = z.object({
  code: z.string().min(1).max(4000).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
});

/** Images that are safe to show inline from the api origin (never SVG or HTML). */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function contentDisposition(kind: 'inline' | 'attachment', filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerMail(r: Router) {
  const mailDeps = (ctx: { deps: MailDeps }) => ctx.deps;

  /* ------------------------------ administration ------------------------------ */

  r.org('mailServerSettings', async (ctx) => {
    requireAdmin(ctx);
    return settingsView(ctx.deps.env, await loadSettings(ctx.deps.db, ctx.org.id));
  });
  r.org('mailUpdateServerSettings', async (ctx) => {
    requireAdmin(ctx);
    const view = await updateSettings(ctx.deps.db, ctx.deps.env, ctx.org.id, ctx.user.id, ctx.body);
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'mail.settings.update',
        targetType: 'org',
        targetId: ctx.org.id,
        meta: {
          imapHost: ctx.body.imapHost,
          smtpHost: ctx.body.smtpHost,
          authMode: ctx.body.authMode,
        },
      },
      ctx.req,
    );
    return view;
  });
  r.org('mailTestServer', async (ctx) => {
    requireAdmin(ctx);
    return testServers(ctx.body);
  });

  /* --------------------------------- account ---------------------------------- */

  r.org('mailAccount', async (ctx) => {
    requireMailUser(ctx);
    return accountState(ctx.deps.db, ctx.org.id, ctx.user.id);
  });
  r.org(
    'mailConnectAccount',
    async (ctx) => {
      requireMailUser(ctx);
      const account = await connectPassword(mailDeps(ctx), ctx.org.id, ctx.user, ctx.body);
      await audit(
        ctx.deps.db,
        {
          orgId: ctx.org.id,
          actorId: ctx.user.id,
          action: 'mail.account.connect',
          targetType: 'mail_account',
          targetId: account.id,
          meta: { email: account.email, authMode: account.authMode },
        },
        ctx.req,
      );
      return account;
    },
    { status: 201 },
  );
  r.org('mailUpdateAccount', async (ctx) => {
    requireMailUser(ctx);
    return updateAccount(mailDeps(ctx), ctx.org.id, ctx.user.id, ctx.body);
  });
  r.org('mailDisconnectAccount', async (ctx) => {
    requireMailUser(ctx);
    await disconnectAccount(ctx.deps.db, ctx.org.id, ctx.user.id);
    await audit(
      ctx.deps.db,
      {
        orgId: ctx.org.id,
        actorId: ctx.user.id,
        action: 'mail.account.disconnect',
        targetType: 'mail_account',
      },
      ctx.req,
    );
    return {};
  });

  /* ----------------------------- folders, messages ---------------------------- */

  const mailbox = async (ctx: Pick<OrgCtx<never>, 'actor' | 'org' | 'user' | 'deps'>) => {
    requireMailUser(ctx);
    return requireMailbox(mailDeps(ctx), ctx.org.id, ctx.user.id);
  };

  /** Mailbox endpoints report where their time went (services/mail/timing.ts). */
  const timedMailbox = <N extends EndpointName>(
    name: N,
    handler: (ctx: OrgCtx<N>, box: MailContext) => Promise<ResponseOf<N>>,
  ) =>
    r.org(name, (ctx) =>
      traced(ctx.c, ctx.deps.logger, name, async () =>
        handler(ctx, await timed('db', () => mailbox(ctx))),
      ),
    );

  timedMailbox('mailFolders', async (ctx, box) => ({
    items: await listFolders(ctx.deps, box),
  }));
  timedMailbox('mailMessages', (ctx, box) => listMessages(ctx.deps, box, ctx.query));
  timedMailbox('mailMessage', (ctx, box) => getMessage(ctx.deps, box, ctx.query));
  timedMailbox('mailThread', (ctx, box) => getThread(ctx.deps, box, ctx.query));
  timedMailbox('mailUpdateFlags', async (ctx, box) => {
    await updateFlags(ctx.deps, box, ctx.body);
    return {};
  });
  timedMailbox('mailMoveMessages', async (ctx, box) => {
    await moveMessages(ctx.deps, box, ctx.body);
    return {};
  });
  r.org(
    'mailStartBulk',
    async (ctx) => startBulk(ctx.deps.db, ctx.deps.jobs, await mailbox(ctx), ctx.body),
    { status: 202 },
  );
  r.org('mailBulkJob', async (ctx) => {
    requireMailUser(ctx);
    return getBulk(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.params.jobId);
  });
  timedMailbox('mailDeleteMessages', (ctx, box) => deleteMessages(ctx.deps, box, ctx.body));

  r.org('mailSend', async (ctx) =>
    sendMessage(ctx.deps, await mailbox(ctx), driveActor(ctx), ctx.body),
  );

  r.org(
    'mailSaveAttachment',
    async (ctx) => {
      const box = ctx.body.inboxId
        ? await inboxMailbox(ctx.deps, inboxActor(ctx), ctx.body.inboxId)
        : await mailbox(ctx);
      const file = await imapOf(ctx.deps, box, (c) =>
        readPart(c, ctx.body.folder, ctx.body.uid, ctx.body.part),
      );
      return saveToDrive(ctx.deps, driveActor(ctx), file, {
        spaceId: ctx.body.spaceId,
        parentId: ctx.body.parentId,
      });
    },
    { status: 201 },
  );

  r.org('mailRecipients', async (ctx) => {
    requireMailUser(ctx);
    return { items: await suggestRecipients(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.query) };
  });

  /* ---------------------------------- raw routes -------------------------------- */

  r.rawOrg('GET', MAIL_RAW_PATHS.attachment, async ({ c, deps, org, actor, user }) => {
    await requireModule(deps.db, org.id, 'mail');
    const q = AttachmentQuery.safeParse(c.req.query());
    if (!q.success) throw new AppError('not_found');
    // A shared inbox's message: its space decides; otherwise the caller's own mailbox.
    if (!q.data.inboxId) requireMailUser({ org, actor });
    const box = q.data.inboxId
      ? await inboxMailbox(deps, inboxActor({ org, actor, user }), q.data.inboxId)
      : await requireMailbox(deps, org.id, user.id);
    const file = await imapOf(deps, box, (client) =>
      readPart(client, q.data.folder, q.data.uid, q.data.part),
    );
    const type = file.contentType.toLowerCase();
    const inline = q.data.inline === true && INLINE_TYPES.has(type);
    c.header('Content-Type', inline ? type : 'application/octet-stream');
    c.header(
      'Content-Disposition',
      contentDisposition(inline ? 'inline' : 'attachment', file.filename),
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('Cache-Control', 'private, no-store');
    return c.body(new Uint8Array(file.content));
  });

  r.rawOrg('GET', MAIL_RAW_PATHS.oauthStart, async ({ c, deps, org, actor, user }) => {
    await requireModule(deps.db, org.id, 'mail');
    requireMailUser({ org, actor });
    const settings = await requireSettings(deps.db, org.id);
    return c.redirect(await startUrl(deps.db, deps.env, settings, user), 302);
  });

  r.rawOrg('GET', MAIL_RAW_PATHS.inboxOauthStart, async ({ c, deps, org, actor, user }) => {
    await requireModule(deps.db, org.id, 'mail');
    const inboxId = InboxOauthStartQuery.parse(c.req.query()).inboxId;
    const start = await inboxSignInStart(deps, inboxActor({ org, actor, user }), inboxId);
    return c.redirect(
      await startUrl(deps.db, deps.env, start.settings, user, {
        inboxId,
        loginHint: user.email,
      }),
      302,
    );
  });

  r.rawOrg(
    'GET',
    MAIL_RAW_PATHS.oauthCallback,
    async ({ c, deps, org, actor, user, handoff }) => {
      const hub = deps.env.HUB_URL.replace(/\/$/, '');
      let inboxId: string | null = null;
      const back = (params: Record<string, string>) => {
        const path = withQuery(inboxId ? `/mail/inbox/${inboxId}` : paths.mail(), params);
        // Started from the app: the browser hands the page back to it.
        return c.redirect(
          handoff ? appReturn(deps.env, handoff.redirectUri, path) : `${hub}${path}`,
          302,
        );
      };
      try {
        await requireModule(deps.db, org.id, 'mail');
        requireMailUser({ org, actor });
        const q = OauthCallbackQuery.parse(c.req.query());
        if (q.error || !q.code || !q.state) {
          throw new AppError('mail_oauth_failed', { reason: q.error ?? 'missing_code' });
        }
        const settings = await requireSettings(deps.db, org.id);
        const done = await finishOauth(deps.db, deps.env, settings, user.id, {
          code: q.code,
          state: q.state,
        });
        inboxId = done.inboxId;
        if (inboxId) {
          const inbox = await inboxSignInFinish(
            deps,
            inboxActor({ org, actor, user }),
            inboxId,
            done.tokens,
          );
          await audit(
            deps.db,
            {
              orgId: org.id,
              actorId: user.id,
              action: 'mail.inbox.update',
              targetType: 'mail_inbox',
              targetId: inbox.id,
              meta: { signIn: inbox.authMode },
            },
            requestInfo(c),
          );
          return back({ connected: '1' });
        }
        const account = await connectOauth(deps, settings, user, done.tokens);
        await audit(
          deps.db,
          {
            orgId: org.id,
            actorId: user.id,
            action: 'mail.account.connect',
            targetType: 'mail_account',
            targetId: account.id,
            meta: { email: account.email, authMode: account.authMode },
          },
          requestInfo(c),
        );
        return back({ connected: '1' });
      } catch (err) {
        deps.logger.warn({ err }, 'mail oauth callback failed');
        const code = err instanceof AppError ? err.code : 'mail_oauth_failed';
        return back({ error: code });
      }
    },
    { handoff: 'mail' },
  );
}
