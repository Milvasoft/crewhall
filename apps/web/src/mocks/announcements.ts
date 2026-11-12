import {
  ANNOUNCEMENT_LIMITS,
  can,
  DEFAULT_KUDOS_BADGES,
  isReactionEmoji,
  type Announcement,
  type Celebration,
  type CelebrationSettings,
  type Kudos,
  type KudosBadge,
  type ModuleEndpointName,
} from '@crewhall/shared';
import { contactsMockState } from './contacts';
import { actorOf, MockApiError, orgCtx, requireUser, summary, type Resolvers } from './core';
import { newId } from './db';
import { USER, type MockState, type MockUser } from './seed';

/** Internal announcements (roadmap 19) in the contract mock. */

type AnnouncementsEndpoint = Extract<
  ModuleEndpointName,
  | 'listAnnouncements'
  | 'getAnnouncementCounts'
  | 'getAnnouncement'
  | 'createAnnouncement'
  | 'updateAnnouncement'
  | 'deleteAnnouncement'
  | 'markAnnouncementRead'
  | 'acknowledgeAnnouncement'
  | 'listAnnouncementReaders'
  | 'listKudos'
  | 'createKudos'
  | 'deleteKudos'
  | 'listKudosBadges'
  | 'createKudosBadge'
  | 'updateKudosBadge'
  | 'getCelebrations'
  | 'getCelebrationSettings'
  | 'updateCelebrationSettings'
>;

interface MockKudos {
  id: string;
  fromUserId: string | null;
  toUserId: string;
  badgeId: string | null;
  message: string | null;
  createdAt: string;
}

interface KudosState {
  badges: KudosBadge[];
  cards: MockKudos[];
  settings: Omit<CelebrationSettings, 'permissions'>;
}

interface MockAnnouncement {
  id: string;
  authorId: string | null;
  title: string;
  body: string;
  pinnedAt: string | null;
  requiresAck: boolean;
  publishedAt: string;
  editedAt: string | null;
  reads: { userId: string; readAt: string; ackedAt: string | null }[];
}

type WithAnnouncements = MockState & { announcements?: MockAnnouncement[]; kudos?: KudosState };

const now = () => new Date().toISOString();
const HOUR = 3_600_000;

function seed(): MockAnnouncement[] {
  const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
  return [
    {
      id: newId(),
      authorId: USER.elif,
      title: 'Yeni izin politikası 1 Kasım’da başlıyor',
      body: 'Merhaba ekip,\n\nYıllık izin talepleri artık en az iki hafta önceden girilmeli. Ayrıntılar Drive › İK klasöründe.\n\nSorularınız için bana yazabilirsiniz.',
      pinnedAt: at(20),
      requiresAck: true,
      publishedAt: at(20),
      editedAt: null,
      reads: [{ userId: USER.elif, readAt: at(20), ackedAt: at(20) }],
    },
    {
      id: newId(),
      authorId: USER.bugra,
      title: 'Cuma 16:00 Milvasoft buluşması',
      body: 'Bu cuma ofiste kısa bir buluşma yapıyoruz. Uzaktan katılmak isteyenler için toplantı linki takvimde.',
      pinnedAt: null,
      requiresAck: false,
      publishedAt: at(50),
      editedAt: null,
      reads: [{ userId: USER.bugra, readAt: at(50), ackedAt: null }],
    },
  ];
}

export function announcementsState(s: MockState): MockAnnouncement[] {
  const x = s as WithAnnouncements;
  x.announcements ??= seed();
  return x.announcements;
}

export function kudosState(s: MockState): KudosState {
  const x = s as WithAnnouncements;
  if (!x.kudos) {
    const badges = DEFAULT_KUDOS_BADGES.map((b, i) => ({
      id: newId(),
      key: b.key,
      emoji: b.emoji,
      name: null,
      position: i,
      archived: false,
    }));
    x.kudos = {
      badges,
      cards: [
        {
          id: newId(),
          fromUserId: USER.elif,
          toUserId: USER.zeynep,
          badgeId: badges[2]!.id,
          message: 'Portal ana sayfa tasarımı harika oldu, teşekkürler!',
          createdAt: new Date(Date.now() - 5 * HOUR).toISOString(),
        },
      ],
      settings: {
        channelId: null,
        birthdays: true,
        anniversaries: true,
        kudos: false,
        timeZone: 'Europe/Istanbul',
      },
    };
  }
  return x.kudos;
}

const isAdmin = (s: MockState, u: MockUser) => {
  const role = actorOf(s, u).orgRole;
  return role === 'owner' || role === 'admin';
};

function kudosView(s: MockState, u: MockUser, k: MockKudos): Kudos | null {
  const to = s.users.find((x) => x.id === k.toUserId);
  if (!to) return null;
  const from = k.fromUserId ? s.users.find((x) => x.id === k.fromUserId) : undefined;
  return {
    id: k.id,
    from: from ? summary(from) : null,
    to: summary(to),
    badge: kudosState(s).badges.find((b) => b.id === k.badgeId) ?? null,
    message: k.message,
    createdAt: k.createdAt,
    permissions: { delete: k.fromUserId === u.id || isAdmin(s, u) },
  };
}

const dayPlus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const audience = (s: MockState) =>
  s.members.filter((m) => m.status === 'active' && m.role !== 'guest').map((m) => m.userId);

function reader(s: MockState): MockUser {
  const u = requireUser(s);
  if (actorOf(s, u).orgRole === 'guest') throw new MockApiError('not_found');
  return u;
}

const canPublish = (s: MockState, u: MockUser) =>
  can(actorOf(s, u), 'announcements.publish', { type: 'org', org: orgCtx(s) });

function canManage(s: MockState, u: MockUser, a: MockAnnouncement) {
  const role = actorOf(s, u).orgRole;
  return canPublish(s, u) && (a.authorId === u.id || role === 'owner' || role === 'admin');
}

function view(s: MockState, u: MockUser, a: MockAnnouncement): Announcement {
  // The author is neither a reader nor in the total (B3).
  const people = new Set(audience(s).filter((id) => id !== a.authorId));
  const reads = a.reads.filter((r) => people.has(r.userId));
  const mine = a.reads.find((r) => r.userId === u.id);
  const author = a.authorId ? s.users.find((x) => x.id === a.authorId) : undefined;
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    author: author ? summary(author) : null,
    pinnedAt: a.pinnedAt,
    requiresAck: a.requiresAck,
    publishedAt: a.publishedAt,
    editedAt: a.editedAt,
    audienceCount: people.size,
    readCount: reads.length,
    ackCount: reads.filter((r) => r.ackedAt).length,
    my: { readAt: mine?.readAt ?? null, ackedAt: mine?.ackedAt ?? null },
    permissions: { manage: canManage(s, u, a) },
  };
}

function find(s: MockState, id: string) {
  const a = announcementsState(s).find((x) => x.id === id);
  if (!a) throw new MockApiError('not_found');
  return a;
}

const unread = (a: MockAnnouncement, userId: string) => {
  const r = a.reads.find((x) => x.userId === userId);
  return !r || (a.requiresAck && !r.ackedAt);
};

function sorted(list: MockAnnouncement[]) {
  return [...list].sort(
    (a, b) =>
      Number(a.pinnedAt === null) - Number(b.pinnedAt === null) ||
      (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '') ||
      b.publishedAt.localeCompare(a.publishedAt),
  );
}

function pinCheck(s: MockState) {
  if (announcementsState(s).filter((a) => a.pinnedAt).length >= ANNOUNCEMENT_LIMITS.pinned) {
    throw new MockApiError('conflict', 'Pin limit');
  }
}

function read(a: MockAnnouncement, userId: string, ack: boolean) {
  let r = a.reads.find((x) => x.userId === userId);
  if (!r) {
    r = { userId, readAt: now(), ackedAt: null };
    a.reads.push(r);
  }
  if (ack) r.ackedAt ??= now();
}

export const announcementsResolvers = {
  listAnnouncements: ({ s, query }) => {
    const u = reader(s);
    const all = sorted(announcementsState(s)).filter((a) => !query.unreadOnly || unread(a, u.id));
    const start = query.cursor ? Number(query.cursor) || 0 : 0;
    return {
      items: all.slice(start, start + query.limit).map((a) => view(s, u, a)),
      nextCursor: start + query.limit < all.length ? String(start + query.limit) : null,
    };
  },
  getAnnouncementCounts: ({ s }) => {
    const u = requireUser(s);
    if (actorOf(s, u).orgRole === 'guest') return { unread: 0, pendingAck: 0 };
    const list = announcementsState(s);
    return {
      unread: list.filter((a) => !a.reads.some((r) => r.userId === u.id)).length,
      pendingAck: list.filter(
        (a) => a.requiresAck && !a.reads.some((r) => r.userId === u.id && r.ackedAt),
      ).length,
    };
  },
  getAnnouncement: ({ s, params }) => view(s, reader(s), find(s, params.announcementId!)),
  createAnnouncement: ({ s, body }) => {
    const u = reader(s);
    if (!canPublish(s, u)) throw new MockApiError('forbidden');
    if (body.pinned) pinCheck(s);
    const at = now();
    const a: MockAnnouncement = {
      id: newId(),
      authorId: u.id,
      title: body.title,
      body: body.body,
      pinnedAt: body.pinned ? at : null,
      requiresAck: body.requiresAck,
      publishedAt: at,
      editedAt: null,
      reads: [{ userId: u.id, readAt: at, ackedAt: at }],
    };
    announcementsState(s).push(a);
    return view(s, u, a);
  },
  updateAnnouncement: ({ s, params, body }) => {
    const u = reader(s);
    const a = find(s, params.announcementId!);
    if (!canManage(s, u, a)) throw new MockApiError('forbidden');
    if (body.pinned && !a.pinnedAt) pinCheck(s);
    if ((body.title && body.title !== a.title) || (body.body && body.body !== a.body)) {
      a.editedAt = now();
    }
    if (body.title !== undefined) a.title = body.title;
    if (body.body !== undefined) a.body = body.body;
    if (body.requiresAck !== undefined) a.requiresAck = body.requiresAck;
    if (body.pinned !== undefined) a.pinnedAt = body.pinned ? (a.pinnedAt ?? now()) : null;
    return view(s, u, a);
  },
  deleteAnnouncement: ({ s, params }) => {
    const u = reader(s);
    const a = find(s, params.announcementId!);
    if (!canManage(s, u, a)) throw new MockApiError('forbidden');
    const list = announcementsState(s);
    list.splice(list.indexOf(a), 1);
    return {};
  },
  markAnnouncementRead: ({ s, params }) => {
    const u = reader(s);
    const a = find(s, params.announcementId!);
    read(a, u.id, false);
    return view(s, u, a);
  },
  acknowledgeAnnouncement: ({ s, params }) => {
    const u = reader(s);
    const a = find(s, params.announcementId!);
    if (!a.requiresAck) throw new MockApiError('invalid_target');
    read(a, u.id, true);
    return view(s, u, a);
  },
  listAnnouncementReaders: ({ s, params }) => {
    const u = reader(s);
    const a = find(s, params.announcementId!);
    if (!canManage(s, u, a)) throw new MockApiError('forbidden');
    const items = audience(s)
      .filter((id) => id !== a.authorId)
      .map((id) => {
        const p = s.users.find((x) => x.id === id);
        const r = a.reads.find((x) => x.userId === id);
        return p
          ? { user: summary(p), readAt: r?.readAt ?? null, ackedAt: r?.ackedAt ?? null }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort(
        (x, y) =>
          Number(x.readAt === null) - Number(y.readAt === null) ||
          x.user.name.localeCompare(y.user.name, 'tr'),
      );
    return {
      items,
      audienceCount: items.length,
      readCount: items.filter((i) => i.readAt).length,
      ackCount: items.filter((i) => i.ackedAt).length,
    };
  },

  listKudos: ({ s, query }) => {
    const u = reader(s);
    const items = kudosState(s)
      .cards.filter((k) => !query.userId || k.toUserId === query.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit)
      .map((k) => kudosView(s, u, k))
      .filter((x): x is Kudos => x !== null);
    return { items, nextCursor: null };
  },
  createKudos: ({ s, body }) => {
    const u = reader(s);
    if (body.toUserId === u.id) throw new MockApiError('bad_request');
    if (!audience(s).includes(body.toUserId)) throw new MockApiError('not_found');
    const badge = kudosState(s).badges.find((b) => b.id === body.badgeId);
    if (!badge) throw new MockApiError('not_found');
    if (badge.archived) throw new MockApiError('bad_request');
    const k: MockKudos = {
      id: newId(),
      fromUserId: u.id,
      toUserId: body.toUserId,
      badgeId: badge.id,
      message: body.message?.trim() || null,
      createdAt: now(),
    };
    kudosState(s).cards.push(k);
    return kudosView(s, u, k)!;
  },
  deleteKudos: ({ s, params }) => {
    const u = reader(s);
    const st = kudosState(s);
    const k = st.cards.find((x) => x.id === params.kudosId);
    if (!k) throw new MockApiError('not_found');
    if (k.fromUserId !== u.id && !isAdmin(s, u)) throw new MockApiError('forbidden');
    st.cards.splice(st.cards.indexOf(k), 1);
    return {};
  },
  listKudosBadges: ({ s }) => {
    const u = reader(s);
    const items = [...kudosState(s).badges].sort((a, b) => a.position - b.position);
    return { items, permissions: { manage: isAdmin(s, u) } };
  },
  createKudosBadge: ({ s, body }) => {
    const u = reader(s);
    if (!isAdmin(s, u)) throw new MockApiError('forbidden');
    if (!isReactionEmoji(body.emoji)) throw new MockApiError('bad_request');
    const st = kudosState(s);
    const b: KudosBadge = {
      id: newId(),
      key: null,
      emoji: body.emoji,
      name: body.name,
      position: st.badges.length,
      archived: false,
    };
    st.badges.push(b);
    return b;
  },
  updateKudosBadge: ({ s, params, body }) => {
    const u = reader(s);
    if (!isAdmin(s, u)) throw new MockApiError('forbidden');
    const b = kudosState(s).badges.find((x) => x.id === params.badgeId);
    if (!b) throw new MockApiError('not_found');
    if (body.name === null && !b.key) throw new MockApiError('bad_request');
    if (body.emoji !== undefined) b.emoji = body.emoji;
    if (body.name !== undefined) b.name = body.name;
    if (body.position !== undefined) b.position = body.position;
    if (body.archived !== undefined) b.archived = body.archived;
    return b;
  },
  getCelebrations: ({ s, query }) => {
    reader(s);
    const today = dayPlus(0);
    const found: Celebration[] = [];
    const active = new Set(audience(s));
    for (let i = 0; i <= query.days; i++) {
      const day = dayPlus(i);
      for (const [userId, p] of Object.entries(contactsMockState().profiles)) {
        const user = s.users.find((x) => x.id === userId);
        if (!user || !active.has(userId)) continue;
        if (p.birthday && p.birthdayVisible && p.birthday === day.slice(5)) {
          found.push({ kind: 'birthday', user: summary(user), date: day, years: null });
        }
        if (p.startedOn && p.startedOn.slice(5) === day.slice(5)) {
          const years = Number(day.slice(0, 4)) - Number(p.startedOn.slice(0, 4));
          if (years >= 1) {
            found.push({ kind: 'anniversary', user: summary(user), date: day, years });
          }
        }
      }
    }
    return {
      today: found.filter((c) => c.date === today),
      upcoming: found.filter((c) => c.date !== today),
    };
  },
  getCelebrationSettings: ({ s }) => {
    const u = reader(s);
    return { ...kudosState(s).settings, permissions: { manage: isAdmin(s, u) } };
  },
  updateCelebrationSettings: ({ s, body }) => {
    const u = reader(s);
    if (!isAdmin(s, u)) throw new MockApiError('forbidden');
    const st = kudosState(s);
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) (st.settings as Record<string, unknown>)[k] = v;
    }
    return { ...st.settings, permissions: { manage: true } };
  },
} satisfies Resolvers<AnnouncementsEndpoint>;
