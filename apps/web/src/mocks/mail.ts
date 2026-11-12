import {
  MAIL_BULK_CHUNK,
  MAIL_MAX_ATTACHMENT_BYTES,
  type ErrorCode,
  type MailBulkJob,
  type MailAccount,
  type MailFolder,
  type MailMessage,
  type MailServerSettings,
  type MailSpecialUse,
} from '@crewhall/shared';
import { memberOf, MockApiError, requireUser, type Resolvers } from './core';
import { newId } from './db';
import { USER, type MockState } from './seed';

/**
 * Mail part of the contract mock (roadmap 24): a small IMAP server in memory. Folders hold
 * messages with UIDs; flags, moves, deletes and sending behave like the real backend (Sent copy,
 * \Answered on replies). Message HTML in the seed is already "sanitized".
 */

interface MockFolder {
  path: string;
  specialUse: MailSpecialUse | null;
  nextUid: number;
  messages: MailMessage[];
}

interface MailMockState {
  settings: Omit<MailServerSettings, 'oauthRedirectUri' | 'hasOauthClientSecret'> & {
    oauthClientSecret: string | null;
  };
  accounts: Record<string, MailAccount & { password: string | null }>;
  folders: Record<string, MockFolder[]>;
  recent: { userId: string; name: string | null; address: string }[];
  /** Folder-wide jobs: they advance one chunk per status poll, like a busy worker. */
  jobs: (MailBulkJob & { userId: string; uids: number[] })[];
  /** Tests: the next flag change or bulk job fails with this code (rollback paths). */
  failNext: ErrorCode | null;
}

/** The app password the mock mailbox accepts (any other is refused like IMAP would). */
export const MOCK_MAIL_PASSWORD = 'uygulama-sifresi';
const REDIRECT_URI = 'http://localhost:3000/api/mail/oauth/callback';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function message(
  folder: string,
  uid: number,
  m: Partial<MailMessage> & Pick<MailMessage, 'subject' | 'from' | 'to'>,
): MailMessage {
  const messageId = m.messageId ?? `<${newId()}@milvasoft.com>`;
  return {
    folder,
    uid,
    messageId,
    threadId: m.threadId ?? messageId,
    // Newer UIDs are newer mail.
    date: m.date ?? ago((10 - uid) * 37),
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: (m.attachments ?? []).some((a) => !a.inline),
    size: 4096,
    cc: [],
    bcc: [],
    replyTo: [],
    inReplyTo: null,
    references: [],
    html: null,
    text: null,
    attachments: [],
    blockedImages: 0,
    ...m,
  };
}

function seedFolders(email: string): MockFolder[] {
  const me = { name: null, address: email };
  const ayse = { name: 'Ayşe Demir', address: 'ayse.demir@musteri.com.tr' };
  const ops = { name: 'Sunucu İzleme', address: 'alerts@milvasoft.com' };
  const proposalId = '<teklif-2026@musteri.com.tr>';
  const inbox: MailMessage[] = [
    message('INBOX', 1, {
      subject: 'Haftalık sunucu raporu',
      from: ops,
      to: [me],
      seen: true,
      text: 'Bu hafta tüm sunucular ayaktaydı.\nOrtalama yanıt süresi: 142 ms.',
    }),
    message('INBOX', 2, {
      subject: 'Teklif ve sözleşme taslağı',
      from: ayse,
      to: [me],
      messageId: proposalId,
      threadId: proposalId,
      html: '<p>Merhaba,</p><p>Teklifi ve sözleşme taslağını ekte bulabilirsiniz.</p><img data-blocked="1"><p>Saygılarımla,<br>Ayşe</p>',
      blockedImages: 1,
      attachments: [
        {
          part: '2',
          filename: 'teklif.pdf',
          contentType: 'application/pdf',
          size: 184_320,
          inline: false,
        },
      ],
    }),
    message('INBOX', 3, {
      subject: 'Bülten: Ekim sayısı',
      from: { name: 'Crewhall Bülten', address: 'bulten@example.com' },
      to: [me],
      flagged: true,
      html: '<h2>Ekim bülteni</h2><p>Bu ay neler yaptık?</p>',
    }),
  ];
  const sent: MailMessage[] = [
    message('Sent', 1, {
      subject: 'Toplantı notları',
      from: me,
      to: [ayse],
      seen: true,
      text: 'Toplantı notlarını paylaşıyorum.',
    }),
  ];
  return [
    { path: 'INBOX', specialUse: 'inbox', nextUid: 4, messages: inbox },
    { path: 'Drafts', specialUse: 'drafts', nextUid: 1, messages: [] },
    { path: 'Sent', specialUse: 'sent', nextUid: 2, messages: sent },
    { path: 'Archive', specialUse: 'archive', nextUid: 1, messages: [] },
    { path: 'Trash', specialUse: 'trash', nextUid: 1, messages: [] },
    { path: 'Projeler', specialUse: null, nextUid: 1, messages: [] },
  ];
}

function seed(s: MockState): MailMockState {
  // The seeded admin starts with a connected mailbox; everyone else connects first.
  const bugra = s.users.find((u) => u.id === USER.bugra);
  const state: MailMockState = {
    settings: {
      configured: true,
      imapHost: 'imap.milvasoft.com',
      imapPort: 993,
      imapSecurity: 'tls',
      smtpHost: 'smtp.milvasoft.com',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      authMode: 'password',
      usernameFormat: 'email',
      oauthClientId: null,
      oauthClientSecret: null,
      oauthTenant: null,
      saveSentCopy: true,
      allowRemoteImages: true,
      pollMinutes: 5,
      updatedAt: ago(60 * 24),
    },
    accounts: {},
    folders: {},
    recent: [],
    jobs: [],
    failNext: null,
  };
  if (bugra) {
    state.accounts[bugra.id] = {
      id: newId(),
      email: bugra.email,
      displayName: bugra.name,
      username: bugra.email,
      authMode: 'password',
      status: 'ok',
      signatureHtml: `<p>${bugra.name}</p>`,
      notify: true,
      lastCheckedAt: ago(2),
      createdAt: ago(60 * 24 * 3),
      password: MOCK_MAIL_PASSWORD,
    };
    state.folders[bugra.id] = seedFolders(bugra.email);
  }
  return state;
}

export function mailMockState(s: MockState): MailMockState {
  const holder = s as MockState & { mail?: MailMockState };
  holder.mail ??= seed(s);
  return holder.mail;
}

function settingsView(m: MailMockState): MailServerSettings {
  const { oauthClientSecret, ...rest } = m.settings;
  return {
    ...rest,
    hasOauthClientSecret: Boolean(oauthClientSecret),
    oauthRedirectUri: REDIRECT_URI,
  };
}

function requireAdmin(s: MockState) {
  const u = requireUser(s);
  const role = memberOf(s, u.id)?.role;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
  return u;
}

function requireMailUser(s: MockState) {
  const u = requireUser(s);
  if ((memberOf(s, u.id)?.role ?? 'guest') === 'guest') throw new MockApiError('forbidden');
  return u;
}

function mailbox(s: MockState) {
  const u = requireMailUser(s);
  const m = mailMockState(s);
  if (!m.settings.configured) throw new MockApiError('mail_not_configured');
  const account = m.accounts[u.id];
  if (!account) throw new MockApiError('mail_account_required');
  if (account.authMode !== m.settings.authMode) throw new MockApiError('mail_auth_mode_mismatch');
  m.folders[u.id] ??= seedFolders(account.email);
  return { u, m, account, folders: m.folders[u.id]! };
}

function folderOf(folders: MockFolder[], path: string) {
  const f = folders.find((x) => x.path === path);
  if (!f) throw new MockApiError('mail_folder_not_found');
  return f;
}

const view = (a: MailAccount & { password: string | null }): MailAccount => ({
  id: a.id,
  email: a.email,
  displayName: a.displayName,
  username: a.username,
  authMode: a.authMode,
  status: a.status,
  signatureHtml: a.signatureHtml,
  notify: a.notify,
  lastCheckedAt: a.lastCheckedAt,
  createdAt: a.createdAt,
});

function matches(m: MailMessage, q: string) {
  const text = [
    m.subject,
    m.from?.name,
    m.from?.address,
    ...m.to.map((a) => a.address),
    m.text,
    m.html,
  ]
    .join(' ')
    .toLocaleLowerCase('tr');
  return text.includes(q.toLocaleLowerCase('tr'));
}

function failIfAsked(m: MailMockState) {
  const code = m.failNext;
  if (!code) return;
  m.failNext = null;
  throw new MockApiError(code);
}

const jobView = ({ userId: _u, uids: _x, ...job }: MailMockState['jobs'][number]): MailBulkJob =>
  job;

/** One chunk of a running job (seen, unseen, move or delete in the mock folders). */
function advance(job: MailMockState['jobs'][number], folders: MockFolder[]) {
  const f = folderOf(folders, job.folder);
  const part = job.uids.slice(job.done, job.done + MAIL_BULK_CHUNK);
  if (job.action === 'seen' || job.action === 'unseen') {
    for (const x of f.messages) if (part.includes(x.uid)) x.seen = job.action === 'seen';
  } else {
    const to =
      job.action === 'move'
        ? folderOf(folders, job.target!)
        : folders.find((x) => x.specialUse === 'trash' && x !== f);
    const moving = f.messages.filter((x) => part.includes(x.uid));
    f.messages = f.messages.filter((x) => !part.includes(x.uid));
    if (to) for (const x of moving) append(to, x);
  }
  job.done += part.length;
  if (job.done >= job.uids.length) {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
  }
}

function folderView(f: MockFolder): MailFolder {
  return {
    path: f.path,
    name: f.path,
    parent: null,
    delimiter: '/',
    specialUse: f.specialUse,
    total: f.messages.length,
    unread: f.messages.filter((m) => !m.seen).length,
  };
}

function append(f: MockFolder, m: Omit<MailMessage, 'folder' | 'uid'>) {
  const copy = { ...m, folder: f.path, uid: f.nextUid++ };
  f.messages.push(copy);
  return copy;
}

export const mailResolvers: Resolvers<
  | 'mailServerSettings'
  | 'mailUpdateServerSettings'
  | 'mailTestServer'
  | 'mailAccount'
  | 'mailConnectAccount'
  | 'mailUpdateAccount'
  | 'mailDisconnectAccount'
  | 'mailFolders'
  | 'mailMessages'
  | 'mailMessage'
  | 'mailThread'
  | 'mailUpdateFlags'
  | 'mailMoveMessages'
  | 'mailDeleteMessages'
  | 'mailSend'
  | 'mailSaveAttachment'
  | 'mailRecipients'
  | 'mailStartBulk'
  | 'mailBulkJob'
> = {
  mailServerSettings: ({ s }) => {
    requireAdmin(s);
    return settingsView(mailMockState(s));
  },
  mailUpdateServerSettings: ({ s, body }) => {
    requireAdmin(s);
    const m = mailMockState(s);
    const secret =
      body.oauthClientSecret === null
        ? null
        : (body.oauthClientSecret ?? m.settings.oauthClientSecret);
    const clientId =
      body.oauthClientId === undefined ? m.settings.oauthClientId : body.oauthClientId || null;
    if (body.authMode !== 'password' && (!clientId || !secret)) {
      throw new MockApiError('bad_request', 'oauth_client_required');
    }
    m.settings = {
      ...m.settings,
      ...body,
      configured: true,
      oauthClientId: clientId,
      oauthClientSecret: secret,
      oauthTenant:
        body.oauthTenant === undefined ? m.settings.oauthTenant : body.oauthTenant || null,
      updatedAt: new Date().toISOString(),
    };
    return settingsView(m);
  },
  mailTestServer: ({ s, body }) => {
    requireAdmin(s);
    const reachable = !/invalid|\.test$/.test(body.imapHost);
    const signedIn = body.password === undefined || body.password === MOCK_MAIL_PASSWORD;
    const probe = (ok: boolean) => ({
      ok: ok && signedIn,
      error: !ok ? 'mail_server_unreachable' : signedIn ? null : 'mail_auth_failed',
      detail: ok ? null : 'ENOTFOUND',
    });
    return { imap: probe(reachable), smtp: probe(!/invalid|\.test$/.test(body.smtpHost)) };
  },

  mailAccount: ({ s }) => {
    const u = requireMailUser(s);
    const m = mailMockState(s);
    const account = m.accounts[u.id];
    return {
      server: {
        configured: m.settings.configured,
        authMode: m.settings.authMode,
        allowRemoteImages: m.settings.allowRemoteImages,
        maxAttachmentBytes: MAIL_MAX_ATTACHMENT_BYTES,
      },
      account: account ? view(account) : null,
    };
  },
  mailConnectAccount: ({ s, body }) => {
    const u = requireMailUser(s);
    const m = mailMockState(s);
    if (!m.settings.configured) throw new MockApiError('mail_not_configured');
    if (m.settings.authMode !== 'password') throw new MockApiError('mail_auth_mode_mismatch');
    if (body.password !== MOCK_MAIL_PASSWORD) throw new MockApiError('mail_auth_failed');
    const account = {
      id: newId(),
      email: body.email.toLowerCase(),
      displayName: body.displayName ?? u.name,
      username: body.username ?? body.email.toLowerCase(),
      authMode: 'password' as const,
      status: 'ok' as const,
      signatureHtml: '',
      notify: true,
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      password: body.password,
    };
    m.accounts[u.id] = account;
    m.folders[u.id] = seedFolders(account.email);
    return view(account);
  },
  mailUpdateAccount: ({ s, body }) => {
    const u = requireMailUser(s);
    const m = mailMockState(s);
    const account = m.accounts[u.id];
    if (!account) throw new MockApiError('mail_account_required');
    if (body.password !== undefined) {
      if (body.password !== MOCK_MAIL_PASSWORD) throw new MockApiError('mail_auth_failed');
      account.password = body.password;
      account.status = 'ok';
    }
    if (body.displayName !== undefined) account.displayName = body.displayName;
    if (body.signatureHtml !== undefined) {
      account.signatureHtml = body.signatureHtml.replace(
        /<script[\s\S]*?<\/script>|\son\w+="[^"]*"/gi,
        '',
      );
    }
    if (body.notify !== undefined) account.notify = body.notify;
    return view(account);
  },
  mailDisconnectAccount: ({ s }) => {
    const u = requireMailUser(s);
    const m = mailMockState(s);
    delete m.accounts[u.id];
    delete m.folders[u.id];
    return {};
  },

  mailFolders: ({ s }) => ({ items: mailbox(s).folders.map(folderView) }),
  mailMessages: ({ s, query }) => {
    const f = folderOf(mailbox(s).folders, query.folder);
    let list = [...f.messages].sort((a, b) => b.uid - a.uid);
    if (query.q) list = list.filter((m) => matches(m, query.q!));
    if (query.unread) list = list.filter((m) => !m.seen);
    if (query.flagged) list = list.filter((m) => m.flagged);
    const cursor = query.cursor ? Number(query.cursor) : null;
    if (cursor) list = list.filter((m) => m.uid < cursor);
    const page = list.slice(0, query.limit);
    return {
      items: page.map((m) => ({
        folder: m.folder,
        uid: m.uid,
        messageId: m.messageId,
        threadId: m.threadId,
        subject: m.subject,
        from: m.from,
        to: m.to,
        date: m.date,
        seen: m.seen,
        flagged: m.flagged,
        answered: m.answered,
        hasAttachments: m.hasAttachments,
        size: m.size,
      })),
      nextCursor: list.length > query.limit ? String(page.at(-1)!.uid) : null,
    };
  },
  mailMessage: ({ s, query }) => {
    const f = folderOf(mailbox(s).folders, query.folder);
    const msg = f.messages.find((m) => m.uid === query.uid);
    if (!msg) throw new MockApiError('mail_message_not_found');
    if (query.markSeen) msg.seen = true;
    return { ...msg, blockedImages: query.remoteImages ? 0 : msg.blockedImages };
  },
  mailThread: ({ s, query }) => {
    const { folders, m } = mailbox(s);
    if (query.remoteImages && !m.settings.allowRemoteImages) {
      throw new MockApiError('mail_remote_images_disabled');
    }
    const f = folderOf(folders, query.folder);
    const msg = f.messages.find((x) => x.uid === query.uid);
    if (!msg) throw new MockApiError('mail_message_not_found');
    const sent = folders.find((x) => x.specialUse === 'sent');
    const pool = [...f.messages, ...(sent && sent !== f ? sent.messages : [])];
    const thread = pool.filter((x) => x.threadId === msg.threadId);
    if (query.markSeen) for (const x of f.messages) if (x.threadId === msg.threadId) x.seen = true;
    return {
      items: thread
        .sort((a, b) => Date.parse(a.date ?? '') - Date.parse(b.date ?? ''))
        .map((x) => ({ ...x, blockedImages: query.remoteImages ? 0 : x.blockedImages })),
    };
  },
  mailUpdateFlags: ({ s, body }) => {
    const { m: state, folders } = mailbox(s);
    failIfAsked(state);
    const f = folderOf(folders, body.folder);
    for (const m of f.messages) {
      if (!body.uids.includes(m.uid)) continue;
      if (body.seen !== undefined) m.seen = body.seen;
      if (body.flagged !== undefined) m.flagged = body.flagged;
    }
    return {};
  },
  mailMoveMessages: ({ s, body }) => {
    const { folders } = mailbox(s);
    const from = folderOf(folders, body.folder);
    const to = folderOf(folders, body.target);
    const moving = from.messages.filter((m) => body.uids.includes(m.uid));
    from.messages = from.messages.filter((m) => !body.uids.includes(m.uid));
    for (const m of moving) append(to, m);
    return {};
  },
  mailDeleteMessages: ({ s, body }) => {
    const { folders } = mailbox(s);
    const from = folderOf(folders, body.folder);
    const trash = folders.find((f) => f.specialUse === 'trash');
    const moving = from.messages.filter((m) => body.uids.includes(m.uid));
    from.messages = from.messages.filter((m) => !body.uids.includes(m.uid));
    if (!trash || trash === from) return { permanent: true };
    for (const m of moving) append(trash, m);
    return { permanent: false };
  },
  mailStartBulk: ({ s, body }) => {
    const { u, m, folders } = mailbox(s);
    const f = folderOf(folders, body.folder);
    if (body.action === 'move') folderOf(folders, body.target ?? '');
    const running = m.jobs.find(
      (j) =>
        j.userId === u.id &&
        j.folder === body.folder &&
        j.action === body.action &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (running) return jobView(running);
    const uids = f.messages
      .filter((x) => (body.action === 'seen' ? !x.seen : body.action === 'unseen' ? x.seen : true))
      .map((x) => x.uid);
    const failing = m.failNext;
    m.failNext = null;
    const job = {
      id: newId(),
      userId: u.id,
      uids,
      folder: body.folder,
      action: body.action,
      target: body.action === 'move' ? (body.target ?? null) : null,
      status: failing ? ('failed' as const) : ('running' as const),
      total: uids.length,
      done: 0,
      error: failing,
      createdAt: new Date().toISOString(),
      finishedAt: failing ? new Date().toISOString() : null,
    };
    m.jobs.push(job);
    return jobView(job);
  },
  mailBulkJob: ({ s, params }) => {
    const { u, m, folders } = mailbox(s);
    const job = m.jobs.find((j) => j.id === params.jobId && j.userId === u.id);
    if (!job) throw new MockApiError('not_found');
    if (job.status === 'running') advance(job, folders);
    return jobView(job);
  },
  mailSend: ({ s, body }) => {
    const { u, m, account, folders } = mailbox(s);
    if (body.to.length + body.cc.length + body.bcc.length === 0) {
      throw new MockApiError('mail_recipients_required');
    }
    const messageId = `<${newId()}@milvasoft.com>`;
    let threadId = messageId;
    if (body.source) {
      const src = folderOf(folders, body.source.folder).messages.find(
        (x) => x.uid === body.source!.uid,
      );
      if (!src) throw new MockApiError('mail_message_not_found');
      if (body.source.mode === 'reply') {
        src.answered = true;
        threadId = src.threadId;
      }
    }
    const sent = folders.find((f) => f.specialUse === 'sent');
    if (sent && m.settings.saveSentCopy) {
      append(sent, {
        messageId,
        threadId,
        subject: body.subject,
        from: { name: account.displayName, address: account.email },
        to: body.to.map((r) => ({ name: r.name ?? null, address: r.address })),
        cc: body.cc.map((r) => ({ name: r.name ?? null, address: r.address })),
        bcc: body.bcc.map((r) => ({ name: r.name ?? null, address: r.address })),
        date: new Date().toISOString(),
        seen: true,
        flagged: false,
        answered: false,
        hasAttachments: body.attachments.length > 0,
        size: body.html.length,
        replyTo: [],
        inReplyTo: null,
        references: [],
        html: body.html,
        text: null,
        attachments: [],
        blockedImages: 0,
      });
    }
    for (const r of [...body.to, ...body.cc, ...body.bcc]) {
      if (!m.recent.some((x) => x.userId === u.id && x.address === r.address.toLowerCase())) {
        m.recent.push({ userId: u.id, name: r.name ?? null, address: r.address.toLowerCase() });
      }
    }
    return { messageId, savedToSent: Boolean(sent && m.settings.saveSentCopy) };
  },
  mailSaveAttachment: ({ s, body }) => {
    const { folders } = mailbox(s);
    const msg = folderOf(folders, body.folder).messages.find((m) => m.uid === body.uid);
    const att = msg?.attachments.find((a) => a.part === body.part);
    if (!att) throw new MockApiError('mail_attachment_not_found');
    const space =
      s.spaces.find((x) => x.id === body.spaceId) ?? s.spaces.find((x) => x.kind === 'personal');
    return { nodeId: newId(), spaceId: space?.id ?? newId(), name: att.filename };
  },
  mailRecipients: ({ s, query }) => {
    const u = requireMailUser(s);
    const m = mailMockState(s);
    const q = query.q.toLocaleLowerCase('tr');
    const hit = (v: string | null) => !q || (v ?? '').toLocaleLowerCase('tr').includes(q);
    const recent = m.recent
      .filter((r) => r.userId === u.id && (hit(r.name) || hit(r.address)))
      .map((r) => ({ name: r.name, address: r.address, source: 'recent' as const }));
    const people = s.users
      .filter((x) => x.id !== u.id && (hit(x.name) || hit(x.email)))
      .map((x) => ({ name: x.name, address: x.email, source: 'member' as const }));
    const out = [...recent, ...people.filter((p) => !recent.some((r) => r.address === p.address))];
    return { items: out.slice(0, query.limit) };
  },
};
