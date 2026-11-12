import { Empty, def, type EndpointDef } from '../endpoint-def';
import {
  AbortDesktopUploadQuery,
  CompleteDesktopUpload,
  CreateDesktopUpload,
  DesktopMultipartUpload,
  DesktopReleaseFile,
  DeleteDesktopReleaseQuery,
  DesktopPlatformReleases,
  DesktopReleases,
  PublishDesktopRelease,
} from '../schemas/desktop';

/**
 * Yönetim › Masaüstü sürümleri: release files go to the S3 bucket under `desktop-updates/`
 * (DESKTOP_UPDATES_S3_PREFIX) and the server writes the electron-updater feed. Install-wide like
 * backups: `desktop.manage_releases`, the owner of the setup wizard's org (Me.installAdmin).
 */
export const desktopEndpoints = {
  listDesktopReleases: def({
    method: 'GET',
    path: '/api/v1/desktop/releases',
    auth: 'session',
    response: DesktopReleases,
  }),
  /**
   * Starts a multipart upload: presigned URLs for every part (DESKTOP_UPLOAD_PART_BYTES each).
   * A file the published feed points to cannot be replaced.
   */
  startDesktopUpload: def({
    method: 'POST',
    path: '/api/v1/desktop/releases/uploads/multipart',
    auth: 'session',
    body: CreateDesktopUpload,
    response: DesktopMultipartUpload,
  }),
  /** Joins the parts (their ETags from the PUT answers) into the file. */
  completeDesktopUpload: def({
    method: 'POST',
    path: '/api/v1/desktop/releases/uploads/multipart/:upload/complete',
    auth: 'session',
    body: CompleteDesktopUpload,
    response: DesktopReleaseFile,
  }),
  /** Drops an unfinished upload (the person cancelled). */
  abortDesktopUpload: def({
    method: 'DELETE',
    path: '/api/v1/desktop/releases/uploads/multipart/:upload',
    auth: 'session',
    query: AbortDesktopUploadQuery,
    response: Empty,
  }),
  /** Hashes the files and writes latest.yml / latest-mac.yml; an older version rolls back. */
  publishDesktopRelease: def({
    method: 'POST',
    path: '/api/v1/desktop/releases/publish',
    auth: 'session',
    body: PublishDesktopRelease,
    response: DesktopPlatformReleases,
  }),
  /** Deletes a version's files (not the published one); its blockmaps stay unless asked. */
  deleteDesktopRelease: def({
    method: 'DELETE',
    path: '/api/v1/desktop/releases/:platform/:version',
    auth: 'session',
    query: DeleteDesktopReleaseQuery,
    response: DesktopPlatformReleases,
  }),
} as const satisfies Record<string, EndpointDef>;
