import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  conversationMembers,
  conversations,
  federationConversations,
  federationMembers,
  federationPeers,
  federationReactions,
  federationUsers,
  messages,
  organizations,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  CHAT_LIMITS,
  isReactionEmoji,
  type Conversation,
  type ConversationFederation,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import {
  defaultNotify,
  loadConversation,
  requireMember,
  requirePermission,
  type ChatActor,
  type ConversationRow,
  type Membership,
  type MessageRow,
} from '../chat/access';
import { afterWrite, publishMessage, removeMessage, writeMessage } from '../chat/messages';
import { mentionedIds, plainText } from '../chat/text';
import { conversationView, usersById } from '../chat/views';
import {
  newActivity,
  ownDomain,
  peerActive,
  postActivity,
  requireActivePeer,
  splitAddress,
  type FedJobDeps,
  type FedOrg,
  type PeerRow,
} from './core';
import { offerFiles, receiveFiles, RemoteFile } from './files';
import { handleOf, upsertRemoteUser, userByHandle } from './handles';
import { meetingsOf } from './meetings';
import { activeShareWith, blockedOf, sharesOf } from './shared';

/**
 * Federated chat (docs/contracts/federasyon.md › Protokol): direct chats with remote people,
 * remote people in groups and space channels, and the message relay. The installation a
 * conversation started on is its home; peers send to the home, the home sends to everyone.
 */

export const Person = z.object({ address: z.string().max(320), name: z.string().max(200) });
type Person = z.infer<typeof Person>;

const addressOf = (handle: string, domain: string) => `${handle}@${domain}`;
const directKey = (userId: string, address: string) => `fed:${userId}:${address}`;

async function loadOrg(db: DbOrTx, orgId: string): Promise<FedOrg> {
  const [o] = await db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!o) throw new AppError('not_found');
  return o;
}

/** Is this chat shared with another installation? */
export async function isFederated(db: DbOrTx, conversationId: string) {
  return (await linksOf(db, conversationId)).length > 0;
}

async function linksOf(db: DbOrTx, conversationId: string) {
  return db
    .select({ link: federationConversations, peer: federationPeers })
    .from(federationConversations)
    .innerJoin(federationPeers, eq(federationPeers.id, federationConversations.peerId))
    .where(eq(federationConversations.conversationId, conversationId));
}

/** Me as the remote side sees me; guests have no address. */
export async function localPerson(
  deps: FedJobDeps,
  orgId: string,
  userId: string,
): Promise<Person> {
  const handle = await handleOf(deps.db, orgId, userId);
  if (!handle) throw new AppError('federation_not_allowed', { reason: 'no_address' });
  const [u] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return { address: addressOf(handle, ownDomain(deps.env)), name: u?.name ?? handle };
}

async function lookup(deps: Deps, org: FedOrg, peer: PeerRow, handle: string): Promise<Person> {
  const answer = await postActivity(
    deps,
    org.id,
    peer.domain,
    newActivity('user.lookup', { handle }),
  );
  const parsed = z.object({ handle: z.string(), name: z.string() }).safeParse(answer);
  if (!parsed.success || parsed.data.handle !== handle) {
    throw new AppError('federation_user_not_found');
  }
  return { address: addressOf(handle, peer.domain), name: parsed.data.name.slice(0, 200) };
}

function requireNotGuest(a: ChatActor) {
  if (a.actor.orgRole === 'guest')
    throw new AppError('federation_not_allowed', { reason: 'guest' });
}

async function addRemoteMemberRow(
  db: DbOrTx,
  conv: ConversationRow,
  peer: PeerRow,
  person: Person,
  addedBy: string | null,
) {
  const { handle } = splitAddress(person.address);
  const ru = await upsertRemoteUser(db, conv.orgId, peer.id, handle, person.name);
  await db
    .insert(federationMembers)
    .values({ conversationId: conv.id, remoteUserId: ru.id, orgId: conv.orgId, addedBy })
    .onConflictDoNothing();
  return ru;
}

async function invite(
  deps: Deps,
  org: FedOrg,
  conv: ConversationRow,
  peer: PeerRow,
  to: string,
  from: Person,
): Promise<string> {
  const members = await remoteMembersOf(deps.db, [conv.id]);
  const answer = await postActivity(
    deps,
    org.id,
    peer.domain,
    newActivity('conversation.invite', {
      conversation: {
        id: conv.id,
        type: conv.type,
        name: conv.type === 'direct' ? null : conv.name,
        homeDomain: ownDomain(deps.env),
      },
      to,
      from,
      members: [
        from,
        ...(members.get(conv.id) ?? []).map((m) => ({ address: m.address, name: m.name })),
      ],
    }),
  );
  const id = z.object({ conversationId: z.uuid() }).safeParse(answer);
  if (!id.success) throw new AppError('federation_peer_unreachable', { domain: peer.domain });
  await deps.db
    .insert(federationConversations)
    .values({
      conversationId: conv.id,
      peerId: peer.id,
      orgId: conv.orgId,
      remoteConversationId: id.data.conversationId,
      homeDomain: ownDomain(deps.env),
    })
    .onConflictDoUpdate({
      target: [federationConversations.conversationId, federationConversations.peerId],
      set: { remoteConversationId: id.data.conversationId },
    });
  return id.data.conversationId;
}

/** createRemoteConversation: the direct chat with `handle@domain`, made on both sides. */
export async function createRemoteConversation(
  deps: Deps,
  a: ChatActor,
  address: string,
): Promise<Conversation> {
  requireNotGuest(a);
  const { handle, domain } = splitAddress(address);
  const peer = await requireActivePeer(deps, a.org, domain);
  const key = directKey(a.userId, address);
  const [existing] = await deps.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.orgId, a.org.id), eq(conversations.directKey, key)));
  if (existing) return conversationView(deps.db, a, existing);

  const me = await localPerson(deps, a.org.id, a.userId);
  const remote = await lookup(deps, a.org, peer, handle);
  const conv = await deps.db.transaction(async (tx) => {
    const [c] = await tx
      .insert(conversations)
      .values({
        orgId: a.org.id,
        type: 'direct',
        name: remote.name,
        directKey: key,
        createdBy: a.userId,
      })
      .returning();
    await tx.insert(conversationMembers).values({
      conversationId: c!.id,
      userId: a.userId,
      orgId: a.org.id,
      notify: defaultNotify('direct'),
      addedBy: a.userId,
    });
    await addRemoteMemberRow(tx, c!, peer, remote, a.userId);
    return c!;
  });
  try {
    await invite(deps, a.org, conv, peer, handle, me);
  } catch (err) {
    await deps.db.delete(conversations).where(eq(conversations.id, conv.id));
    throw err;
  }
  return conversationView(deps.db, a, conv);
}

/** addRemoteConversationMember: groups and space channels; only on the conversation's home. */
export async function addRemoteMember(
  deps: Deps,
  a: ChatActor,
  conversationId: string,
  address: string,
): Promise<Conversation> {
  requireNotGuest(a);
  const m = await requireMember(deps.db, a, conversationId);
  requirePermission(a, m, 'manage');
  const conv = m.conv;
  if (conv.type !== 'group' && conv.type !== 'space') {
    throw new AppError('federation_not_allowed', { reason: 'type' });
  }
  const links = await linksOf(deps.db, conv.id);
  if (links.some((l) => l.link.homeDomain !== ownDomain(deps.env))) {
    throw new AppError('federation_not_allowed', { reason: 'not_home' });
  }
  const { handle, domain } = splitAddress(address);
  const peer = await requireActivePeer(deps, a.org, domain);
  const remote = await lookup(deps, a.org, peer, handle);
  const me = await localPerson(deps, a.org.id, a.userId);
  await addRemoteMemberRow(deps.db, conv, peer, remote, a.userId);
  await invite(deps, a.org, conv, peer, handle, me);
  // Other installations in the conversation learn the new person.
  const all = (await remoteMembersOf(deps.db, [conv.id])).get(conv.id) ?? [];
  for (const l of links) {
    if (l.peer.id === peer.id || !l.link.remoteConversationId || !peerActive(a.org, l.peer))
      continue;
    await deps.jobs.send('federation.deliver', {
      orgId: a.org.id,
      domain: l.peer.domain,
      activity: newActivity('conversation.members', {
        conversationId: l.link.remoteConversationId,
        members: all.map((x) => ({ address: x.address, name: x.name })),
      }),
    });
  }
  return conversationView(deps.db, a, conv);
}

/**
 * After a local write (sendMessage) or an accepted remote one: queue `message.create` for the
 * installations that should get it. The home sends to every peer but `except`; a peer sends to
 * the home only. Attachments stay here (files are shared as links).
 */
async function routeOf(deps: FedJobDeps, conv: ConversationRow, except?: string) {
  const links = await linksOf(deps.db, conv.id);
  if (links.length === 0) return null;
  const org = await loadOrg(deps.db, conv.orgId);
  const home = links[0]!.link.homeDomain === ownDomain(deps.env);
  const targets = links.filter(
    (l) =>
      l.peer.id !== except &&
      l.link.remoteConversationId !== null &&
      peerActive(org, l.peer) &&
      (home || l.peer.domain === l.link.homeDomain),
  );
  return targets.length ? { org, home, targets } : null;
}

/** Queues one activity per target installation, naming each one's copy of the conversation. */
async function relay(
  deps: FedJobDeps,
  route: NonNullable<Awaited<ReturnType<typeof routeOf>>>,
  type: string,
  fields: Record<string, unknown>,
) {
  for (const l of route.targets) {
    await deps.jobs.send('federation.deliver', {
      orgId: route.org.id,
      domain: l.peer.domain,
      activity: newActivity(type, { conversationId: l.link.remoteConversationId, ...fields }),
    });
  }
}

/** A message's identity on every installation: where it was written and its id there. */
function originOf(msg: MessageRow, own: string) {
  return msg.body.remote
    ? { id: msg.body.remote.originId, domain: msg.body.remote.domain }
    : { id: msg.id, domain: own };
}

/** Mention tokens point at local ids: other installations get the names. */
async function portableText(deps: FedJobDeps, text: string) {
  const people = await usersById(deps.db, mentionedIds([text]));
  return plainText(text, new Map([...people.values()].map((u) => [u.id, u.name])));
}

export async function federateMessage(
  deps: FedJobDeps,
  conv: ConversationRow,
  msg: MessageRow,
  except?: string,
) {
  if (msg.kind !== 'user' || msg.deletedAt) return;
  const route = await routeOf(deps, conv, except);
  if (!route) return;
  const { org, targets } = route;
  let from: Person;
  let originId = msg.id;
  if (msg.body.remote) {
    from = { address: msg.body.remote.address, name: msg.body.remote.name };
    originId = msg.body.remote.originId;
  } else if (msg.authorId) {
    try {
      from = await localPerson(deps, org.id, msg.authorId);
    } catch {
      // A guest in a federated conversation: their message stays here.
      return;
    }
  } else {
    return;
  }
  const text = await portableText(deps, msg.text);
  const files = await offerFiles(deps.db, org, conv, msg);
  for (const l of targets) {
    await deps.jobs.send('federation.deliver', {
      orgId: org.id,
      domain: l.peer.domain,
      activity: newActivity('message.create', {
        conversationId: l.link.remoteConversationId,
        message: {
          id: originId,
          from,
          text,
          createdAt: msg.createdAt.toISOString(),
          ...(files.length ? { files } : {}),
        },
      }),
    });
  }
}

/** After the author edited a message here (or the home accepted a remote edit). */
export async function federateEdit(
  deps: FedJobDeps,
  conv: ConversationRow,
  msg: MessageRow,
  except?: string,
) {
  if (msg.kind !== 'user' || msg.deletedAt) return;
  const route = await routeOf(deps, conv, except);
  if (!route) return;
  await relay(deps, route, 'message.update', {
    message: { ...originOf(msg, ownDomain(deps.env)), text: await portableText(deps, msg.text) },
  });
}

/**
 * After a delete here (`msg` as it was before). The home's deletes reach everyone; another
 * installation's reach the others only for its own people's messages, the rest stays local.
 */
export async function federateDelete(
  deps: FedJobDeps,
  conv: ConversationRow,
  msg: MessageRow,
  except?: string,
) {
  if (msg.kind !== 'user') return;
  const route = await routeOf(deps, conv, except);
  if (!route) return;
  const own = ownDomain(deps.env);
  const origin = originOf(msg, own);
  if (!route.home && origin.domain !== own) return;
  await relay(deps, route, 'message.delete', { message: origin });
}

/** A local person's reaction; guests have no address and their reactions stay here. */
export async function federateReaction(
  deps: FedJobDeps,
  conv: ConversationRow,
  msg: MessageRow,
  userId: string,
  emoji: string,
  on: boolean,
) {
  if (msg.kind !== 'user') return;
  const route = await routeOf(deps, conv);
  if (!route) return;
  let from: Person;
  try {
    from = await localPerson(deps, conv.orgId, userId);
  } catch {
    return;
  }
  await relay(deps, route, 'reaction.set', {
    message: originOf(msg, ownDomain(deps.env)),
    from,
    emoji,
    on,
  });
}

// ---- Inbound (the inbox dispatches here after the signature checks) ----

export const InviteActivity = z.object({
  conversation: z.object({
    id: z.uuid(),
    type: z.enum(['direct', 'group', 'space']),
    name: z.string().max(200).nullable(),
    homeDomain: z.string(),
  }),
  to: z.string().max(64),
  from: Person,
  members: z.array(Person).max(500).default([]),
});

export async function receiveInvite(
  deps: Deps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof InviteActivity>,
) {
  if (
    input.conversation.homeDomain !== peer.domain ||
    splitAddress(input.from.address).domain !== peer.domain
  ) {
    throw new AppError('federation_not_allowed', { reason: 'not_home' });
  }
  const local = await userByHandle(deps.db, org.id, input.to);
  if (!local) throw new AppError('federation_user_not_found');
  const remoteId = input.conversation.id;
  const direct = input.conversation.type === 'direct';
  return deps.db.transaction(async (tx) => {
    const [known] = await tx
      .select({ conversationId: federationConversations.conversationId })
      .from(federationConversations)
      .where(
        and(
          eq(federationConversations.peerId, peer.id),
          eq(federationConversations.remoteConversationId, remoteId),
        ),
      );
    let conv: ConversationRow | null = known
      ? await loadConversation(tx, org.id, known.conversationId)
      : null;
    if (!conv && direct) {
      // The same pair again (they removed and re-created it): reuse our side.
      const [same] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.orgId, org.id),
            eq(conversations.directKey, directKey(local.id, input.from.address)),
          ),
        );
      conv = same ?? null;
    }
    if (!conv) {
      const [c] = await tx
        .insert(conversations)
        .values({
          orgId: org.id,
          type: direct ? 'direct' : 'group',
          name: direct ? input.from.name : (input.conversation.name ?? input.from.name),
          directKey: direct ? directKey(local.id, input.from.address) : null,
          // Like a local chat, it shows to the invited person from its first message (4.17).
          createdBy: null,
        })
        .returning();
      conv = c!;
    }
    await tx
      .insert(conversationMembers)
      .values({
        conversationId: conv.id,
        userId: local.id,
        orgId: org.id,
        notify: defaultNotify(conv.type),
        addedBy: null,
      })
      .onConflictDoNothing();
    await tx
      .insert(federationConversations)
      .values({
        conversationId: conv.id,
        peerId: peer.id,
        orgId: org.id,
        remoteConversationId: remoteId,
        homeDomain: peer.domain,
      })
      .onConflictDoUpdate({
        target: [federationConversations.conversationId, federationConversations.peerId],
        set: { remoteConversationId: remoteId },
      });
    for (const p of input.members) {
      if (splitAddress(p.address).domain === peer.domain) {
        await addRemoteMemberRow(tx, conv, peer, p, null);
      }
    }
    return { conversationId: conv.id };
  });
}

export const MembersActivity = z.object({
  conversationId: z.uuid(),
  members: z.array(Person).max(500),
});

export async function receiveMembers(
  deps: Deps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof MembersActivity>,
) {
  const link = await linkFor(deps.db, peer, input.conversationId);
  if (link.homeDomain !== peer.domain)
    throw new AppError('federation_not_allowed', { reason: 'not_home' });
  const conv = await loadConversation(deps.db, org.id, link.conversationId);
  for (const p of input.members) {
    if (splitAddress(p.address).domain === peer.domain) {
      await addRemoteMemberRow(deps.db, conv, peer, p, null);
    }
  }
  return {};
}

export const MessageActivity = z.object({
  conversationId: z.uuid(),
  message: z.object({
    id: z.uuid(),
    from: Person,
    text: z.string().max(CHAT_LIMITS.messageChars),
    createdAt: z.string().max(40),
    files: z.array(RemoteFile).max(CHAT_LIMITS.attachmentsPerMessage).default([]),
  }),
});

async function linkFor(db: DbOrTx, peer: PeerRow, conversationId: string) {
  const [link] = await db
    .select()
    .from(federationConversations)
    .where(
      and(
        eq(federationConversations.peerId, peer.id),
        eq(federationConversations.conversationId, conversationId),
      ),
    );
  if (!link) throw new AppError('not_found');
  return link;
}

/** Mention tokens from elsewhere would point at our people's ids: they arrive as plain text. */
const defang = (text: string) => text.replace(/<@([^>]*)>/g, '@$1');

export async function receiveMessage(
  deps: Deps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof MessageActivity>,
) {
  const own = ownDomain(deps.env);
  const link = await linkFor(deps.db, peer, input.conversationId);
  const conv = await loadConversation(deps.db, org.id, link.conversationId);
  const { from, id: originId, text } = input.message;
  const { handle, domain } = splitAddress(from.address);
  if (!handle || domain === own) throw new AppError('federation_not_allowed', { reason: 'author' });
  const weAreHome = link.homeDomain === own;
  if (weAreHome && domain !== peer.domain) {
    throw new AppError('federation_not_allowed', { reason: 'author' });
  }
  if (!weAreHome && link.homeDomain !== peer.domain) {
    throw new AppError('federation_not_allowed', { reason: 'not_home' });
  }
  if ((await admit(deps, conv, peer, from, weAreHome)) === 'blocked') return {};
  const [dup] = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        sql`${messages.body}->'remote'->>'originId' = ${originId}`,
      ),
    );
  if (dup) return { messageId: dup.id };

  const membership: Membership = { conv, row: null, spaceRole: null, isMember: true };
  const result = await deps.db.transaction((tx) =>
    writeMessage(deps, tx, membership, {
      authorId: null,
      kind: 'user',
      text: defang(text).slice(0, CHAT_LIMITS.messageChars),
      remote: { address: from.address, name: from.name.slice(0, 200), domain, originId },
    }),
  );
  await afterWrite(deps, conv, result.msg, result.notes);
  const waiting = await receiveFiles(deps, org, peer.id, conv, result.msg, input.message.files);
  // With files, the home relays once it holds its own copies (files.ts › afterFiles).
  if (weAreHome && waiting === 0) await federateMessage(deps, conv, result.msg, peer.id);
  return { messageId: result.msg.id };
}

/**
 * Whether a person of `peer` may speak here. On the home: people we added, those in the
 * invite, and anyone of an organization the channel is shared with; elsewhere the home
 * vouches. Someone a moderator blocked is refused on the home and dropped elsewhere.
 */
async function admit(
  deps: Deps,
  conv: ConversationRow,
  peer: PeerRow,
  from: Person,
  weAreHome: boolean,
): Promise<'ok' | 'blocked'> {
  const { handle, domain } = splitAddress(from.address);
  if (domain !== peer.domain) return 'ok';
  const [member] = await deps.db
    .select({ blockedAt: federationMembers.blockedAt })
    .from(federationMembers)
    .innerJoin(federationUsers, eq(federationUsers.id, federationMembers.remoteUserId))
    .where(
      and(
        eq(federationMembers.conversationId, conv.id),
        eq(federationUsers.peerId, peer.id),
        eq(federationUsers.handle, handle),
      ),
    );
  if (member?.blockedAt) {
    if (weAreHome) throw new AppError('federation_not_allowed', { reason: 'blocked' });
    return 'blocked';
  }
  if (weAreHome && !member) {
    if (!(await activeShareWith(deps.db, conv.id, peer.id))) {
      throw new AppError('federation_not_allowed', { reason: 'not_member' });
    }
    await addRemoteMemberRow(deps.db, conv, peer, from, null);
  } else if (weAreHome) {
    await upsertRemoteUser(deps.db, conv.orgId, peer.id, handle, from.name);
  } else {
    await addRemoteMemberRow(deps.db, conv, peer, from, null);
  }
  return 'ok';
}

const Origin = z.object({ id: z.uuid(), domain: z.string().min(1).max(260) });

export const EditActivity = z.object({
  conversationId: z.uuid(),
  message: Origin.extend({ text: z.string().max(CHAT_LIMITS.messageChars) }),
});

export const DeleteActivity = z.object({ conversationId: z.uuid(), message: Origin });

export const ReactionActivity = z.object({
  conversationId: z.uuid(),
  message: Origin,
  from: Person,
  emoji: z.string().min(1).max(64),
  on: z.boolean(),
});

/** The conversation an activity names; a non-home only hears from the home. */
async function inbound(deps: Deps, org: FedOrg, peer: PeerRow, conversationId: string) {
  const own = ownDomain(deps.env);
  const link = await linkFor(deps.db, peer, conversationId);
  const conv = await loadConversation(deps.db, org.id, link.conversationId);
  const weAreHome = link.homeDomain === own;
  if (!weAreHome && link.homeDomain !== peer.domain) {
    throw new AppError('federation_not_allowed', { reason: 'not_home' });
  }
  return { own, conv, weAreHome };
}

async function byOrigin(
  db: DbOrTx,
  conversationId: string,
  origin: z.infer<typeof Origin>,
  own: string,
) {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        origin.domain === own
          ? eq(messages.id, origin.id)
          : and(
              sql`${messages.body}->'remote'->>'originId' = ${origin.id}`,
              sql`${messages.body}->'remote'->>'domain' = ${origin.domain}`,
            ),
      ),
    );
  return row ?? null;
}

/** `message.update`: only the author's installation edits (relayed by the home). */
export async function receiveEdit(
  deps: Deps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof EditActivity>,
) {
  const { own, conv, weAreHome } = await inbound(deps, org, peer, input.conversationId);
  const origin = input.message;
  if (origin.domain === own || (weAreHome && origin.domain !== peer.domain)) {
    throw new AppError('federation_not_allowed', { reason: 'author' });
  }
  const msg = await byOrigin(deps.db, conv.id, origin, own);
  if (!msg || msg.deletedAt) return {};
  const [row] = await deps.db
    .update(messages)
    .set({ text: defang(origin.text).slice(0, CHAT_LIMITS.messageChars), editedAt: new Date() })
    .where(eq(messages.id, msg.id))
    .returning();
  await publishMessage(deps, conv, 'message.updated', row!);
  if (weAreHome) await federateEdit(deps, conv, row!, peer.id);
  return {};
}

/**
 * `message.delete`: from the home, any message (its moderators set the channel's rules);
 * from another installation, only its own people's messages.
 */
export async function receiveDelete(
  deps: Deps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof DeleteActivity>,
) {
  const { own, conv, weAreHome } = await inbound(deps, org, peer, input.conversationId);
  if (weAreHome && input.message.domain !== peer.domain) {
    throw new AppError('federation_not_allowed', { reason: 'author' });
  }
  const msg = await byOrigin(deps.db, conv.id, input.message, own);
  if (!msg || msg.deletedAt) return {};
  await removeMessage(deps, conv, msg, null);
  if (weAreHome) await federateDelete(deps, conv, msg, peer.id);
  return {};
}

/** `reaction.set`: a remote person's reaction, kept by address (they have no users row). */
export async function receiveReaction(
  deps: Deps,
  org: FedOrg,
  peer: PeerRow,
  input: z.infer<typeof ReactionActivity>,
) {
  const { own, conv, weAreHome } = await inbound(deps, org, peer, input.conversationId);
  const { domain } = splitAddress(input.from.address);
  if (domain === own || (weAreHome && domain !== peer.domain)) {
    throw new AppError('federation_not_allowed', { reason: 'author' });
  }
  if (input.on && !isReactionEmoji(input.emoji)) throw new AppError('chat_invalid_reaction');
  if ((await admit(deps, conv, peer, input.from, weAreHome)) === 'blocked') return {};
  const msg = await byOrigin(deps.db, conv.id, input.message, own);
  if (!msg || msg.deletedAt) return {};
  const changed = input.on
    ? await deps.db
        .insert(federationReactions)
        .values({
          messageId: msg.id,
          address: input.from.address,
          orgId: org.id,
          name: input.from.name.slice(0, 200),
          emoji: input.emoji,
        })
        .onConflictDoNothing()
        .returning()
    : await deps.db
        .delete(federationReactions)
        .where(
          and(
            eq(federationReactions.messageId, msg.id),
            eq(federationReactions.address, input.from.address),
            eq(federationReactions.emoji, input.emoji),
          ),
        )
        .returning();
  if (changed.length === 0) return {};
  const [row] = await deps.db
    .update(messages)
    .set({ updatedAt: new Date() })
    .where(eq(messages.id, msg.id))
    .returning();
  await publishMessage(deps, conv, 'message.updated', row!);
  if (weAreHome) {
    const route = await routeOf(deps, conv, peer.id);
    if (route) {
      await relay(deps, route, 'reaction.set', {
        message: input.message,
        from: input.from,
        emoji: input.emoji,
        on: input.on,
      });
    }
  }
  return {};
}

// ---- Views ----

interface RemoteMember {
  address: string;
  name: string;
  domain: string;
}

export async function remoteMembersOf(db: DbOrTx, ids: string[]) {
  const out = new Map<string, RemoteMember[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      conversationId: federationMembers.conversationId,
      handle: federationUsers.handle,
      name: federationUsers.name,
      domain: federationPeers.domain,
    })
    .from(federationMembers)
    .innerJoin(federationUsers, eq(federationUsers.id, federationMembers.remoteUserId))
    .innerJoin(federationPeers, eq(federationPeers.id, federationUsers.peerId))
    .where(inArray(federationMembers.conversationId, ids));
  for (const r of rows) {
    const list = out.get(r.conversationId) ?? [];
    list.push({ address: addressOf(r.handle, r.domain), name: r.name, domain: r.domain });
    out.set(r.conversationId, list);
  }
  return out;
}

/** Conversation.federation for a page of conversations. */
export async function federationOf(
  db: DbOrTx,
  org: FedOrg,
  ids: string[],
): Promise<Map<string, ConversationFederation>> {
  const out = new Map<string, ConversationFederation>();
  if (ids.length === 0) return out;
  const links = await db
    .select({ link: federationConversations, peer: federationPeers })
    .from(federationConversations)
    .innerJoin(federationPeers, eq(federationPeers.id, federationConversations.peerId))
    .where(inArray(federationConversations.conversationId, ids));
  const shares = await sharesOf(db, ids);
  if (links.length === 0 && shares.size === 0) return out;
  const blocked = await blockedOf(db, ids);
  const members = await remoteMembersOf(db, [
    ...new Set([...links.map((l) => l.link.conversationId), ...shares.keys()]),
  ]);
  for (const l of links) {
    const f = out.get(l.link.conversationId) ?? {
      homeDomain: l.link.homeDomain,
      domains: [],
      remoteMembers: members.get(l.link.conversationId) ?? [],
      active: true,
    };
    f.domains.push(l.peer.domain);
    f.active = f.active && peerActive(org, l.peer);
    out.set(l.link.conversationId, f);
  }
  for (const [id, shared] of shares) {
    const f = out.get(id);
    if (f) {
      out.set(id, { ...f, shared });
    } else if (shared.role === 'guest') {
      // The copy of a channel whose share closed: read-only history; the host was its home.
      out.set(id, {
        homeDomain: shared.orgs[0]!.domain,
        domains: [],
        remoteMembers: members.get(id) ?? [],
        active: false,
        shared,
      });
    }
  }
  for (const [id, addresses] of blocked) {
    const f = out.get(id);
    if (f) out.set(id, { ...f, blocked: addresses });
  }
  for (const [id, meeting] of await meetingsOf(db, [...out.keys()])) {
    out.set(id, { ...out.get(id)!, meeting });
  }
  return out;
}
