import {
  can,
  type MailCannedResponse,
  type MailConversation,
  type MailConversationNote,
  type MailInbox,
  type MailMessage,
  type SpaceAction,
} from '@crewhall/shared';
import { actorOf, MockApiError, myRole, orgCtx, requireUser, type Resolvers } from './core';
import { newId } from './db';
import { SPACE, USER, type MockState } from './seed';

/**
 * Shared inbox part of the contract mock (sonraki-isler.md "Ortak gelen kutusu"): the
 * Altyapı space's destek@ inbox with a few conversations. Messages are kept per conversation.
 */

type MockConversation = Omit<MailConversation, 'replying' | 'noteCount'>;

interface InboxMockState {
  inboxes: (Omit<
    MailInbox,
    'counts' | 'canWork' | 'canManage' | 'spaceName' | 'authMode' | 'needsSignIn'
  > & {
    /** null: signs in with the org's provider (Microsoft 365) after it is added. */
    password: string | null;
  })[];
  conversations: MockConversation[];
  canned: MailCannedResponse[];
  replying: Record<string, { id: string; name: string; imageUrl: string | null }[]>;
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function msg(uid: number, subject: string, from: string, to: string, text: string, min: number) {
  const messageId = `<${newId()}@example.com>`;
  return {
    folder: 'INBOX',
    uid,
    messageId,
    threadId: messageId,
    subject,
    from: { name: null, address: from },
    to: [{ name: null, address: to }],
    date: ago(min),
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    size: 1200,
    cc: [],
    bcc: [],
    replyTo: [],
    inReplyTo: null,
    references: [],
    html: `<p>${text}</p>`,
    text,
    attachments: [],
    blockedImages: 0,
  } satisfies MailMessage;
}

function seed(): InboxMockState {
  const inboxId = '00000000-0000-4000-8000-000000000901';
  const email = 'destek@milvasoft.com';
  const conv = (
    n: number,
    subject: string,
    customer: string,
    min: number,
    extra: Partial<MockConversation> = {},
  ): MockConversation => {
    const m = msg(n, subject, customer, email, `${subject} hakkında yardım istiyorum.`, min);
    return {
      id: `00000000-0000-4000-8000-00000000091${n}`,
      inboxId,
      threadId: m.threadId,
      subject,
      customer: { name: null, address: customer },
      status: 'open',
      assignee: null,
      tags: [],
      messageCount: 1,
      unread: true,
      firstMessageAt: m.date,
      lastMessageAt: m.date,
      lastInboundAt: m.date,
      firstResponseAt: null,
      sla: { dueAt: new Date(Date.parse(m.date) + 60 * 60_000).toISOString(), breached: min > 60 },
      messages: [m],
      notes: [],
      ...extra,
    };
  };
  return {
    inboxes: [
      {
        id: inboxId,
        spaceId: SPACE.altyapi,
        name: 'Destek',
        email,
        username: email,
        signatureHtml: '<p>Milvasoft Destek</p>',
        slaFirstResponseMinutes: 60,
        status: 'ok',
        createdAt: ago(60 * 24 * 10),
        password: 'destek-sifresi',
      },
    ],
    conversations: [
      conv(1, 'Faturam gelmedi', 'musteri@example.com', 20, { tags: ['fatura'] }),
      conv(2, 'Şifre sıfırlama', 'ayse@example.com', 90),
      conv(3, 'Teşekkürler', 'can@example.com', 600, { status: 'resolved', unread: false }),
    ],
    canned: [
      {
        id: '00000000-0000-4000-8000-000000000931',
        inboxId,
        title: 'Fatura yeniden gönderildi',
        html: '<p>Faturanız e-postanıza yeniden gönderildi.</p>',
        createdAt: ago(600),
        updatedAt: ago(600),
      },
    ],
    replying: {},
  };
}

export function inboxMockState(s: MockState): InboxMockState {
  const holder = s as MockState & { mailInbox?: InboxMockState };
  holder.mailInbox ??= seed();
  return holder.mailInbox;
}

function allowed(s: MockState, spaceId: string, action: SpaceAction) {
  const u = requireUser(s);
  return can(actorOf(s, u), action, {
    type: 'space',
    org: orgCtx(s),
    myRole: myRole(s, spaceId, u.id),
  });
}

function inboxOf(s: MockState, inboxId: string, action: SpaceAction = 'mail.inbox.view') {
  const i = inboxMockState(s).inboxes.find((x) => x.id === inboxId);
  if (!i || !allowed(s, i.spaceId, 'mail.inbox.view')) throw new MockApiError('not_found');
  if (!allowed(s, i.spaceId, action)) throw new MockApiError('forbidden');
  return i;
}

function view(s: MockState, i: InboxMockState['inboxes'][number]): MailInbox {
  const u = requireUser(s);
  const list = inboxMockState(s).conversations.filter((c) => c.inboxId === i.id);
  return {
    id: i.id,
    spaceId: i.spaceId,
    name: i.name,
    email: i.email,
    username: i.username,
    signatureHtml: i.signatureHtml,
    slaFirstResponseMinutes: i.slaFirstResponseMinutes,
    status: i.status,
    authMode: i.password ? 'password' : 'oauth_microsoft',
    needsSignIn: !i.password,
    createdAt: i.createdAt,
    spaceName: s.spaces.find((x) => x.id === i.spaceId)?.name ?? '',
    counts: {
      open: list.filter((c) => c.status === 'open').length,
      unassigned: list.filter((c) => c.status === 'open' && !c.assignee).length,
      mine: list.filter((c) => c.status !== 'resolved' && c.assignee?.id === u.id).length,
    },
    canWork: allowed(s, i.spaceId, 'mail.inbox.work'),
    canManage: allowed(s, i.spaceId, 'mail.inbox.manage'),
  };
}

function conversationOf(s: MockState, inboxId: string, id: string) {
  const c = inboxMockState(s).conversations.find((x) => x.inboxId === inboxId && x.id === id);
  if (!c) throw new MockApiError('not_found');
  return c;
}

const summary = ({ messages: _m, notes, ...c }: MockConversation) => ({
  ...c,
  noteCount: notes.length,
});

function person(s: MockState) {
  const u = requireUser(s);
  return { id: u.id, name: u.name, imageUrl: null };
}

export const mailInboxResolvers: Resolvers<
  | 'mailInboxes'
  | 'mailCreateInbox'
  | 'mailUpdateInbox'
  | 'mailDeleteInbox'
  | 'mailInboxConversations'
  | 'mailInboxConversation'
  | 'mailUpdateInboxConversation'
  | 'mailAddInboxNote'
  | 'mailDeleteInboxNote'
  | 'mailInboxReplying'
  | 'mailInboxReply'
  | 'mailInboxTags'
  | 'mailCannedResponses'
  | 'mailCreateCannedResponse'
  | 'mailUpdateCannedResponse'
  | 'mailDeleteCannedResponse'
> = {
  mailInboxes: ({ s }) => ({
    items: inboxMockState(s)
      .inboxes.filter((i) => allowed(s, i.spaceId, 'mail.inbox.view'))
      .map((i) => view(s, i)),
  }),
  mailCreateInbox: ({ s, body }) => {
    if (!allowed(s, body.spaceId, 'mail.inbox.manage')) throw new MockApiError('forbidden');
    const m = inboxMockState(s);
    if (m.inboxes.some((i) => i.email === body.email.toLowerCase())) {
      throw new MockApiError('mail_inbox_exists');
    }
    const row = {
      id: newId(),
      spaceId: body.spaceId,
      name: body.name,
      email: body.email.toLowerCase(),
      username: body.username ?? body.email.toLowerCase(),
      signatureHtml: body.signatureHtml ?? '',
      slaFirstResponseMinutes: body.slaFirstResponseMinutes ?? null,
      status: 'ok' as const,
      createdAt: new Date().toISOString(),
      password: body.password ?? null,
    };
    m.inboxes.push(row);
    return view(s, row);
  },
  mailUpdateInbox: ({ s, params, body }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.manage');
    if (body.name !== undefined) i.name = body.name;
    if (body.signatureHtml !== undefined) i.signatureHtml = body.signatureHtml;
    if (body.slaFirstResponseMinutes !== undefined) {
      i.slaFirstResponseMinutes = body.slaFirstResponseMinutes;
    }
    if (body.password !== undefined) i.password = body.password;
    return view(s, i);
  },
  mailDeleteInbox: ({ s, params }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.manage');
    const m = inboxMockState(s);
    m.inboxes = m.inboxes.filter((x) => x !== i);
    m.conversations = m.conversations.filter((c) => c.inboxId !== i.id);
    return {};
  },
  mailInboxConversations: ({ s, params, query }) => {
    const i = inboxOf(s, params.inboxId ?? '');
    const u = requireUser(s);
    const q = query.q?.toLocaleLowerCase('tr');
    const items = inboxMockState(s)
      .conversations.filter(
        (c) =>
          c.inboxId === i.id &&
          (query.status === 'all' || c.status === query.status) &&
          (query.assignee === undefined ||
            (query.assignee === 'me'
              ? c.assignee?.id === u.id
              : query.assignee === 'none'
                ? !c.assignee
                : c.assignee?.id === query.assignee)) &&
          (!query.tag || c.tags.includes(query.tag)) &&
          (!q ||
            c.subject.toLocaleLowerCase('tr').includes(q) ||
            (c.customer?.address ?? '').includes(q)),
      )
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .map(summary);
    return { items, nextCursor: null };
  },
  mailInboxConversation: ({ s, params }) => {
    const i = inboxOf(s, params.inboxId ?? '');
    const c = conversationOf(s, i.id, params.conversationId ?? '');
    if (allowed(s, i.spaceId, 'mail.inbox.work')) {
      c.unread = false;
      for (const m of c.messages) m.seen = true;
    }
    return {
      ...c,
      noteCount: c.notes.length,
      replying: inboxMockState(s).replying[c.id] ?? [],
    };
  },
  mailUpdateInboxConversation: ({ s, params, body }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const c = conversationOf(s, i.id, params.conversationId ?? '');
    if (body.status) c.status = body.status;
    if (body.tags) c.tags = [...new Set(body.tags)];
    if (body.assigneeId !== undefined) {
      if (body.assigneeId === null) c.assignee = null;
      else {
        const user = s.users.find((x) => x.id === body.assigneeId);
        if (!user || myRole(s, i.spaceId, user.id) === null) {
          throw new MockApiError('mail_inbox_assignee_invalid');
        }
        c.assignee = { id: user.id, name: user.name, imageUrl: null };
      }
    }
    return summary(c);
  },
  mailAddInboxNote: ({ s, params, body }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const c = conversationOf(s, i.id, params.conversationId ?? '');
    const note: MailConversationNote = {
      id: newId(),
      author: person(s),
      body: body.body,
      createdAt: new Date().toISOString(),
    };
    c.notes.push(note);
    return note;
  },
  mailDeleteInboxNote: ({ s, params }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const c = conversationOf(s, i.id, params.conversationId ?? '');
    const note = c.notes.find((n) => n.id === (params.noteId ?? ''));
    if (!note) throw new MockApiError('not_found');
    if (note.author?.id !== requireUser(s).id && !allowed(s, i.spaceId, 'mail.inbox.manage')) {
      throw new MockApiError('forbidden');
    }
    c.notes = c.notes.filter((n) => n !== note);
    return {};
  },
  mailInboxReplying: ({ s, params, body }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const c = conversationOf(s, i.id, params.conversationId ?? '');
    const m = inboxMockState(s);
    const me = person(s);
    const others = (m.replying[c.id] ?? []).filter((p) => p.id !== me.id);
    m.replying[c.id] = body.active ? [...others, me] : others;
    return {};
  },
  mailInboxReply: ({ s, params, body }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const c = conversationOf(s, i.id, params.conversationId ?? '');
    const now = new Date().toISOString();
    const reply = msg(
      100 + c.messages.length,
      body.subject,
      i.email,
      body.to[0]?.address ?? '',
      body.html.replace(/<[^>]+>/g, ' ').trim(),
      0,
    );
    c.messages.push({
      ...reply,
      folder: 'Sent',
      html: body.html,
      seen: true,
      from: { name: i.name, address: i.email },
    });
    c.messageCount = c.messages.length;
    c.lastMessageAt = now;
    c.firstResponseAt ??= now;
    if (body.status) c.status = body.status;
    c.assignee ??= person(s);
    if (c.sla.dueAt) c.sla = { ...c.sla, breached: now > c.sla.dueAt };
    return { messageId: reply.messageId, savedToSent: true };
  },
  mailInboxTags: ({ s, params }) => {
    const i = inboxOf(s, params.inboxId ?? '');
    const tags = inboxMockState(s)
      .conversations.filter((c) => c.inboxId === i.id)
      .flatMap((c) => c.tags);
    return { items: [...new Set(tags)].sort() };
  },
  mailCannedResponses: ({ s, params }) => {
    const i = inboxOf(s, params.inboxId ?? '');
    return { items: inboxMockState(s).canned.filter((c) => c.inboxId === i.id) };
  },
  mailCreateCannedResponse: ({ s, params, body }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const now = new Date().toISOString();
    const row = {
      id: newId(),
      inboxId: i.id,
      title: body.title,
      html: body.html,
      createdAt: now,
      updatedAt: now,
    };
    inboxMockState(s).canned.push(row);
    return row;
  },
  mailUpdateCannedResponse: ({ s, params, body }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const row = inboxMockState(s).canned.find(
      (c) => c.inboxId === i.id && c.id === (params.cannedId ?? ''),
    );
    if (!row) throw new MockApiError('not_found');
    if (body.title !== undefined) row.title = body.title;
    if (body.html !== undefined) row.html = body.html;
    row.updatedAt = new Date().toISOString();
    return row;
  },
  mailDeleteCannedResponse: ({ s, params }) => {
    const i = inboxOf(s, params.inboxId ?? '', 'mail.inbox.work');
    const m = inboxMockState(s);
    m.canned = m.canned.filter((c) => !(c.inboxId === i.id && c.id === (params.cannedId ?? '')));
    return {};
  },
};

export { USER };
