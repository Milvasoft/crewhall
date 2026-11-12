import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { mailRecentRecipients } from '@crewhall/db';
import { MAIL_MAX_ATTACHMENT_BYTES, type MailSend, type MailSendResult } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { DriveActor } from '../drive/access';
import { imapOf, type MailContext } from './accounts';
import { readDriveFile } from './drive';
import { isAuthError, isUnreachable, smtpAddress, smtpTransport } from './imap';
import { loadState, setFlags } from './cache';
import { forgetFolders, lockFolder, specialFolder } from './folders';
import { messageHeaders, readPart } from './messages';
import { htmlToText, sanitizeHtml } from './sanitize';
import { syncFolder } from './sync';

type SendDeps = Pick<Deps, 'db' | 'env' | 'logger' | 'storage'>;

interface FileAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

async function collectAttachments(
  deps: SendDeps,
  ctx: MailContext,
  a: DriveActor,
  input: MailSend['attachments'],
): Promise<FileAttachment[]> {
  const out: FileAttachment[] = [];
  let total = 0;
  const add = (f: FileAttachment) => {
    total += f.content.length;
    if (total > MAIL_MAX_ATTACHMENT_BYTES) {
      throw new AppError('mail_attachments_too_large', { maxBytes: MAIL_MAX_ATTACHMENT_BYTES });
    }
    out.push(f);
  };
  for (const item of input) {
    if (item.kind === 'upload') {
      add({
        filename: item.filename,
        contentType: item.contentType,
        content: Buffer.from(item.data, 'base64'),
      });
    } else if (item.kind === 'drive') {
      add(await readDriveFile(deps, a, item.nodeId));
    } else {
      add(await imapOf(deps, ctx, (c) => readPart(c, item.folder, item.uid, item.part)));
    }
  }
  return out;
}

/** Reply / forward headers of the source message. */
async function threading(deps: SendDeps, ctx: MailContext, source: MailSend['source']) {
  if (!source) return null;
  const original = await imapOf(deps, ctx, (c) => messageHeaders(c, source.folder, source.uid));
  if (!original.messageId) return { original, inReplyTo: undefined, references: undefined };
  const references = [
    ...original.references.filter((r) => r !== original.messageId),
    original.messageId,
  ];
  return {
    original,
    inReplyTo: original.messageId,
    references: references.slice(-20).join(' '),
  };
}

function domainOf(address: string) {
  return address.split('@')[1] ?? 'localhost';
}

export async function sendMessage(
  deps: SendDeps,
  ctx: MailContext,
  a: DriveActor & { userName: string },
  input: MailSend,
): Promise<MailSendResult> {
  if (input.to.length + input.cc.length + input.bcc.length === 0) {
    throw new AppError('mail_recipients_required');
  }
  const files = await collectAttachments(deps, ctx, a, input.attachments);
  const thread = await threading(deps, ctx, input.source);
  const html = sanitizeHtml(input.html, { remoteImages: true }).html;
  const from = { name: ctx.account.displayName || a.userName, address: ctx.account.email };
  const messageId = `<${randomUUID()}@${domainOf(ctx.account.email)}>`;
  const fmt = (list: MailSend['to']) =>
    list.map((r) => (r.name ? { name: r.name, address: r.address } : r.address));
  const options: Mail.Options = {
    from,
    to: fmt(input.to),
    cc: fmt(input.cc),
    bcc: fmt(input.bcc),
    subject: input.subject,
    html,
    text: input.text ?? htmlToText(html),
    messageId,
    date: new Date(),
    inReplyTo: thread?.inReplyTo,
    references: thread?.references,
    attachments: files.map((f) => ({
      filename: f.filename,
      contentType: f.contentType,
      content: f.content,
    })),
    headers: { 'X-Mailer': 'Crewhall' },
  };

  const signIn = await ctx.auth();
  // A shared inbox signed in by an admin sends with the admin's own SMTP login (SendAs the inbox).
  const auth =
    'accessToken' in signIn && ctx.account.oauthUser
      ? { ...signIn, user: ctx.account.oauthUser }
      : signIn;
  const transport = smtpTransport(smtpAddress(ctx.settings), auth);
  try {
    const node = new MailComposer(options).compile();
    const envelope = node.getEnvelope();
    await transport.sendMail({ envelope, raw: await node.build() });
  } catch (err) {
    deps.logger.warn({ err, accountId: ctx.account.id }, 'mail send failed');
    if (isAuthError(err)) throw new AppError('mail_auth_failed');
    if (isUnreachable(err)) throw new AppError('mail_server_unreachable');
    throw new AppError('mail_send_failed');
  } finally {
    transport.close();
  }

  await remember(deps, ctx, a, [...input.to, ...input.cc, ...input.bcc]);

  let savedToSent = false;
  try {
    await imapOf(deps, ctx, async (c) => {
      if (ctx.settings.saveSentCopy) {
        const sent = await specialFolder(c, 'sent', { create: true, accountId: ctx.account.id });
        if (sent) {
          // The Sent copy keeps Bcc so the sender still sees who got it.
          const copy = new MailComposer(options).compile();
          copy.keepBcc = true;
          await c.append(sent, await copy.build(), ['\\Seen']);
          savedToSent = true;
          // The reply joins its conversation at once: threads read Sent from the cache.
          const owner = { orgId: ctx.account.orgId, accountId: ctx.account.id };
          if ((await loadState(deps.db, owner, sent))?.complete) {
            await syncFolder(deps.db, c, owner, sent);
          }
        }
      }
      if (input.source && thread) {
        const lock = await lockFolder(c, input.source.folder);
        try {
          const flag = input.source.mode === 'reply' ? '\\Answered' : '$Forwarded';
          await c.messageFlagsAdd([input.source.uid], [flag], { uid: true });
        } finally {
          lock.release();
        }
        if (input.source.mode === 'reply') {
          const owner = { orgId: ctx.account.orgId, accountId: ctx.account.id };
          await setFlags(deps.db, owner, input.source.folder, [input.source.uid], {
            answered: true,
          });
        }
      }
    });
    forgetFolders(ctx.account.id);
  } catch (err) {
    // The message went out; a failed copy or flag must not turn into an error (no resend).
    deps.logger.warn({ err, accountId: ctx.account.id }, 'mail sent, saving the copy failed');
  }
  return { messageId, savedToSent };
}

async function remember(deps: SendDeps, ctx: MailContext, a: DriveActor, list: MailSend['to']) {
  const seen = new Map<string, string | null>();
  for (const r of list) seen.set(r.address.toLowerCase(), r.name ?? null);
  if (seen.size === 0) return;
  await deps.db
    .insert(mailRecentRecipients)
    .values(
      [...seen].map(([address, name]) => ({
        orgId: ctx.account.orgId,
        userId: a.userId,
        address,
        name,
      })),
    )
    .onConflictDoUpdate({
      target: [
        mailRecentRecipients.orgId,
        mailRecentRecipients.userId,
        mailRecentRecipients.address,
      ],
      set: {
        useCount: sql`${mailRecentRecipients.useCount} + 1`,
        lastUsedAt: new Date(),
        name: sql`coalesce(excluded.name, ${mailRecentRecipients.name})`,
      },
    });
}
