import { z } from 'zod';
import { isReactionEmoji } from './chat';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Internal announcements and news feed (roadmap 19). Inward-facing: the audience is every
 * active member of the org (guests excluded); the portal stays the outward-facing site.
 * Writing needs `announcements.publish` (org admins, or members granted the permission).
 */

export const ANNOUNCEMENT_LIMITS = { titleChars: 200, bodyChars: 20_000, pinned: 10 } as const;

export const Announcement = z.object({
  id: Id,
  title: z.string(),
  /** Plain text with line breaks; links are made clickable by the clients. */
  body: z.string(),
  author: UserSummary.nullable(),
  /** Important: stays on top of the feed and on the home card. */
  pinnedAt: Timestamp.nullable(),
  /** Readers are asked to confirm "Okudum". */
  requiresAck: z.boolean(),
  publishedAt: Timestamp,
  editedAt: Timestamp.nullable(),
  /** Everyone it is for (active members, not guests) and how many opened / confirmed it. */
  audienceCount: z.number().int(),
  readCount: z.number().int(),
  ackCount: z.number().int(),
  my: z.object({ readAt: Timestamp.nullable(), ackedAt: Timestamp.nullable() }),
  permissions: z.object({
    /** Edit, pin, delete and see who read it: its author or an org admin with the permission. */
    manage: z.boolean(),
  }),
});
export type Announcement = z.infer<typeof Announcement>;

export const ListAnnouncementsQuery = z.object({
  /** Only the ones the caller has not opened (or not confirmed, when asked to). */
  unreadOnly: z.stringbool().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const title = z.string().trim().min(1).max(ANNOUNCEMENT_LIMITS.titleChars);
const body = z.string().trim().min(1).max(ANNOUNCEMENT_LIMITS.bodyChars);

export const CreateAnnouncement = z.object({
  title,
  body,
  pinned: z.boolean().default(false),
  requiresAck: z.boolean().default(false),
});
export type CreateAnnouncement = z.infer<typeof CreateAnnouncement>;

export const UpdateAnnouncement = z.object({
  title: title.optional(),
  body: body.optional(),
  pinned: z.boolean().optional(),
  requiresAck: z.boolean().optional(),
});
export type UpdateAnnouncement = z.infer<typeof UpdateAnnouncement>;

/** Home card and rail badge. */
export const AnnouncementCounts = z.object({
  unread: z.number().int(),
  /** Asked to confirm "Okudum" and not yet confirmed. */
  pendingAck: z.number().int(),
});
export type AnnouncementCounts = z.infer<typeof AnnouncementCounts>;

export const AnnouncementReader = z.object({
  user: UserSummary,
  readAt: Timestamp.nullable(),
  ackedAt: Timestamp.nullable(),
});
export type AnnouncementReader = z.infer<typeof AnnouncementReader>;

/** Who read it: everyone in the audience, readers first (manage permission). */
export const AnnouncementReaders = z.object({
  items: z.array(AnnouncementReader),
  audienceCount: z.number().int(),
  readCount: z.number().int(),
  ackCount: z.number().int(),
});
export type AnnouncementReaders = z.infer<typeof AnnouncementReaders>;

// ---- thank-you wall (kudos), birthdays and work anniversaries ------------------------------

export const KUDOS_LIMITS = { messageChars: 500, badges: 24, badgeNameChars: 40 } as const;

/** The six ready badges every org starts with (names from i18n `kudos.badges.<key>`). */
export const DEFAULT_KUDOS_BADGES = [
  { key: 'teamwork', emoji: '🤝' },
  { key: 'helping', emoji: '🙌' },
  { key: 'idea', emoji: '💡' },
  { key: 'customer', emoji: '⭐' },
  { key: 'quality', emoji: '🏆' },
  { key: 'extraMile', emoji: '🚀' },
] as const;
export type DefaultKudosBadgeKey = (typeof DEFAULT_KUDOS_BADGES)[number]['key'];

const BadgeEmoji = z.string().refine(isReactionEmoji);

export const KudosBadge = z.object({
  id: Id,
  /** A ready badge's key; null for the org's own. */
  key: z.string().nullable(),
  emoji: z.string(),
  /** Null on a ready badge that was not renamed: show `kudos.badges.<key>`. */
  name: z.string().nullable(),
  position: z.number().int(),
  archived: z.boolean(),
});
export type KudosBadge = z.infer<typeof KudosBadge>;

/** All badges, archived ones too (old cards keep them); `manage`: org admins. */
export const KudosBadges = z.object({
  items: z.array(KudosBadge),
  permissions: z.object({ manage: z.boolean() }),
});
export type KudosBadges = z.infer<typeof KudosBadges>;

export const CreateKudosBadge = z.object({
  emoji: BadgeEmoji,
  name: z.string().trim().min(1).max(KUDOS_LIMITS.badgeNameChars),
});
export type CreateKudosBadge = z.infer<typeof CreateKudosBadge>;

export const UpdateKudosBadge = z.object({
  emoji: BadgeEmoji.optional(),
  /** Null on a ready badge goes back to its translated name. */
  name: z.string().trim().min(1).max(KUDOS_LIMITS.badgeNameChars).nullable().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
});
export type UpdateKudosBadge = z.infer<typeof UpdateKudosBadge>;

export const Kudos = z.object({
  id: Id,
  from: UserSummary.nullable(),
  to: UserSummary,
  badge: KudosBadge.nullable(),
  message: z.string().nullable(),
  createdAt: Timestamp,
  /** Its sender or an org admin may take it back. */
  permissions: z.object({ delete: z.boolean() }),
});
export type Kudos = z.infer<typeof Kudos>;

export const ListKudosQuery = z.object({
  /** Cards this person received (their profile). */
  userId: Id.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const CreateKudos = z.object({
  toUserId: Id,
  badgeId: Id,
  message: z.string().trim().max(KUDOS_LIMITS.messageChars).nullable().optional(),
});
export type CreateKudos = z.infer<typeof CreateKudos>;

export const CelebrationKind = z.enum(['birthday', 'anniversary']);
export type CelebrationKind = z.infer<typeof CelebrationKind>;

export const Celebration = z.object({
  kind: CelebrationKind,
  user: UserSummary,
  /** The day it falls on this time ('YYYY-MM-DD', the org's time zone). */
  date: z.string(),
  /** Work anniversaries: years completed that day; null for birthdays (no year is kept). */
  years: z.number().int().nullable(),
});
export type Celebration = z.infer<typeof Celebration>;

export const CelebrationsQuery = z.object({
  /** Upcoming window after today, in days. */
  days: z.coerce.number().int().min(1).max(60).default(14),
});

/** Home card: today's and the coming days' birthdays (visible ones) and work anniversaries. */
export const Celebrations = z.object({
  today: z.array(Celebration),
  upcoming: z.array(Celebration),
});
export type Celebrations = z.infer<typeof Celebrations>;

/** The daily post to a channel; nothing is posted while `channelId` is null. */
export const CelebrationSettings = z.object({
  channelId: Id.nullable(),
  birthdays: z.boolean(),
  anniversaries: z.boolean(),
  /** Each new thank-you card is also posted there. */
  kudos: z.boolean(),
  /** IANA zone of the org's day, e.g. "Europe/Istanbul". */
  timeZone: z.string(),
  permissions: z.object({ manage: z.boolean() }),
});
export type CelebrationSettings = z.infer<typeof CelebrationSettings>;

export const UpdateCelebrationSettings = z.object({
  channelId: Id.nullable().optional(),
  birthdays: z.boolean().optional(),
  anniversaries: z.boolean().optional(),
  kudos: z.boolean().optional(),
  timeZone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
});
export type UpdateCelebrationSettings = z.infer<typeof UpdateCelebrationSettings>;
