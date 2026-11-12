import { def, Empty, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import {
  Announcement,
  AnnouncementCounts,
  AnnouncementReaders,
  Celebrations,
  CelebrationSettings,
  CelebrationsQuery,
  CreateAnnouncement,
  CreateKudos,
  CreateKudosBadge,
  Kudos,
  KudosBadge,
  KudosBadges,
  ListAnnouncementsQuery,
  ListKudosQuery,
  UpdateAnnouncement,
  UpdateCelebrationSettings,
  UpdateKudosBadge,
} from '../schemas/announcements';

/**
 * Internal announcements (roadmap 19). Reading: every active member (not guests). Writing:
 * `can(actor, 'announcements.publish', org)`; changing one also needs to be its author or an
 * org admin. Publishing notifies everyone (bell, push, e-mail per preferences).
 */
export const announcementsEndpoints = {
  /** Pinned first (newest pin on top), then newest published. */
  listAnnouncements: def({
    method: 'GET',
    path: '/api/v1/announcements',
    auth: 'session',
    query: ListAnnouncementsQuery,
    response: page(Announcement),
  }),
  getAnnouncementCounts: def({
    method: 'GET',
    path: '/api/v1/announcements/counts',
    auth: 'session',
    response: AnnouncementCounts,
  }),
  getAnnouncement: def({
    method: 'GET',
    path: '/api/v1/announcements/:announcementId',
    auth: 'session',
    response: Announcement,
  }),
  createAnnouncement: def({
    method: 'POST',
    path: '/api/v1/announcements',
    auth: 'session',
    body: CreateAnnouncement,
    response: Announcement,
  }),
  /** Text changes mark it edited; pinning keeps at most ANNOUNCEMENT_LIMITS.pinned. */
  updateAnnouncement: def({
    method: 'PATCH',
    path: '/api/v1/announcements/:announcementId',
    auth: 'session',
    body: UpdateAnnouncement,
    response: Announcement,
  }),
  deleteAnnouncement: def({
    method: 'DELETE',
    path: '/api/v1/announcements/:announcementId',
    auth: 'session',
    response: Empty,
  }),
  /** Opened: counts once per person. */
  markAnnouncementRead: def({
    method: 'POST',
    path: '/api/v1/announcements/:announcementId/read',
    auth: 'session',
    response: Announcement,
  }),
  /** "Okudum" on one that asks for it (also marks it read). */
  acknowledgeAnnouncement: def({
    method: 'POST',
    path: '/api/v1/announcements/:announcementId/ack',
    auth: 'session',
    response: Announcement,
  }),
  listAnnouncementReaders: def({
    method: 'GET',
    path: '/api/v1/announcements/:announcementId/readers',
    auth: 'session',
    response: AnnouncementReaders,
  }),

  // ---- Thank-you wall (kudos) ------------------------------------------------------------
  /** Newest first; `userId`: the cards one person received. Guests: 404. */
  listKudos: def({
    method: 'GET',
    path: '/api/v1/kudos',
    auth: 'session',
    query: ListKudosQuery,
    response: page(Kudos),
  }),
  /** To another active member (not yourself, not a guest), with an active badge. */
  createKudos: def({
    method: 'POST',
    path: '/api/v1/kudos',
    auth: 'session',
    body: CreateKudos,
    response: Kudos,
  }),
  deleteKudos: def({
    method: 'DELETE',
    path: '/api/v1/kudos/:kudosId',
    auth: 'session',
    response: Empty,
  }),
  /** The six ready ones are created on first use; changes: org admins. */
  listKudosBadges: def({
    method: 'GET',
    path: '/api/v1/kudos-badges',
    auth: 'session',
    response: KudosBadges,
  }),
  createKudosBadge: def({
    method: 'POST',
    path: '/api/v1/kudos-badges',
    auth: 'session',
    body: CreateKudosBadge,
    response: KudosBadge,
  }),
  updateKudosBadge: def({
    method: 'PATCH',
    path: '/api/v1/kudos-badges/:badgeId',
    auth: 'session',
    body: UpdateKudosBadge,
    response: KudosBadge,
  }),

  // ---- Birthdays and work anniversaries -------------------------------------------------
  /** From the directory profiles: birthdays only of people who show them. */
  getCelebrations: def({
    method: 'GET',
    path: '/api/v1/celebrations',
    auth: 'session',
    query: CelebrationsQuery,
    response: Celebrations,
  }),
  getCelebrationSettings: def({
    method: 'GET',
    path: '/api/v1/celebrations/settings',
    auth: 'session',
    response: CelebrationSettings,
  }),
  /** Org admins; the channel must be a channel the caller can write to. */
  updateCelebrationSettings: def({
    method: 'PATCH',
    path: '/api/v1/celebrations/settings',
    auth: 'session',
    body: UpdateCelebrationSettings,
    response: CelebrationSettings,
  }),
} as const satisfies Record<string, EndpointDef>;
