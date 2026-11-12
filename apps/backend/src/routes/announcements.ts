import type { EndpointName } from '@crewhall/shared';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import {
  acknowledgeAnnouncement,
  announcementCounts,
  createAnnouncement,
  deleteAnnouncement,
  getAnnouncement,
  listAnnouncements,
  listReaders,
  readAnnouncement,
  updateAnnouncement,
  type AnnouncementActor,
} from '../services/announcements';
import {
  createBadge,
  createKudos,
  deleteKudos,
  getCelebrations,
  getSettings,
  listBadges,
  listKudos,
  updateBadge,
  updateSettings,
} from '../services/announcements/kudos';

const actor = <N extends EndpointName>(ctx: OrgCtx<N>): AnnouncementActor => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
});

/** Internal announcements and news feed (roadmap 19). */
export function registerAnnouncements(r: Router): void {
  r.org('listAnnouncements', (ctx) => listAnnouncements(ctx.deps.db, actor(ctx), ctx.query));
  // Before `/:announcementId`, which would read "counts" as an id.
  r.org('getAnnouncementCounts', (ctx) => announcementCounts(ctx.deps.db, actor(ctx)));
  r.org('getAnnouncement', (ctx) =>
    getAnnouncement(ctx.deps.db, actor(ctx), ctx.params.announcementId),
  );
  r.org('createAnnouncement', (ctx) => createAnnouncement(ctx.deps, actor(ctx), ctx.body), {
    status: 201,
  });
  r.org('updateAnnouncement', (ctx) =>
    updateAnnouncement(ctx.deps, actor(ctx), ctx.params.announcementId, ctx.body),
  );
  r.org('deleteAnnouncement', async (ctx) => {
    await deleteAnnouncement(ctx.deps, actor(ctx), ctx.params.announcementId);
    return {};
  });
  r.org('markAnnouncementRead', (ctx) =>
    readAnnouncement(ctx.deps.db, actor(ctx), ctx.params.announcementId),
  );
  r.org('acknowledgeAnnouncement', (ctx) =>
    acknowledgeAnnouncement(ctx.deps.db, actor(ctx), ctx.params.announcementId),
  );
  r.org('listAnnouncementReaders', (ctx) =>
    listReaders(ctx.deps.db, actor(ctx), ctx.params.announcementId),
  );

  // Thank-you wall, birthdays and work anniversaries.
  r.org('listKudos', (ctx) => listKudos(ctx.deps.db, actor(ctx), ctx.query));
  r.org('createKudos', (ctx) => createKudos(ctx.deps, actor(ctx), ctx.body), { status: 201 });
  r.org('deleteKudos', async (ctx) => {
    await deleteKudos(ctx.deps.db, actor(ctx), ctx.params.kudosId);
    return {};
  });
  r.org('listKudosBadges', (ctx) => listBadges(ctx.deps.db, actor(ctx)));
  r.org('createKudosBadge', (ctx) => createBadge(ctx.deps.db, actor(ctx), ctx.body), {
    status: 201,
  });
  r.org('updateKudosBadge', (ctx) =>
    updateBadge(ctx.deps.db, actor(ctx), ctx.params.badgeId, ctx.body),
  );
  r.org('getCelebrationSettings', (ctx) => getSettings(ctx.deps.db, actor(ctx)));
  r.org('updateCelebrationSettings', (ctx) => updateSettings(ctx.deps.db, actor(ctx), ctx.body));
  r.org('getCelebrations', (ctx) => getCelebrations(ctx.deps.db, actor(ctx), ctx.query));
}
