import type { MountItem } from '@crewhall/shared';
import { graph, graphAll, graphRaw, GraphError, msFetch, type AppCredentials } from '../graph';
import { joinPath, type MountAdapter } from './adapter';

/**
 * SharePoint document libraries and OneDrives through Microsoft Graph with the org's app
 * registration (application permission Sites.ReadWrite.All or Sites.Selected for SharePoint,
 * Files.ReadWrite.All for OneDrive). Crewhall's space rights decide who sees the mount.
 */

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: unknown;
  file?: { mimeType?: string };
}

const SELECT = '$select=id,name,size,lastModifiedDateTime,folder,file';
/** Graph's single PUT limit; larger files go through an upload session. */
const SIMPLE_UPLOAD = 4 * 1024 * 1024;
/** Upload session chunks must be multiples of 320 KiB. */
const CHUNK = 10 * 320 * 1024;

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** `/drives/{id}/root` or `/drives/{id}/root:/{path}:` for a path inside the drive. */
const itemRef = (driveId: string, path: string) =>
  path ? `/drives/${driveId}/root:/${encodePath(path)}:` : `/drives/${driveId}/root`;

/** The drive behind a SharePoint site URL (+ library name) or a person's OneDrive. */
export async function resolveDriveId(
  creds: AppCredentials,
  target: { kind: 'sharepoint'; siteUrl: string; library: string } | { kind: 'onedrive'; user: string },
) {
  if (target.kind === 'onedrive') {
    const drive = await graph<{ id: string }>(creds, `/users/${encodeURIComponent(target.user)}/drive?$select=id`);
    return drive.id;
  }
  const url = new URL(target.siteUrl);
  const sitePath = url.pathname.replace(/\/+$/, '');
  const site = await graph<{ id: string }>(
    creds,
    sitePath ? `/sites/${url.hostname}:${encodeURI(sitePath)}?$select=id` : `/sites/${url.hostname}?$select=id`,
  );
  if (!target.library) {
    const drive = await graph<{ id: string }>(creds, `/sites/${site.id}/drive?$select=id`);
    return drive.id;
  }
  const drives = await graphAll<{ id: string; name: string }>(creds, `/sites/${site.id}/drives?$select=id,name`);
  const wanted = target.library.toLowerCase();
  const found = drives.find((d) => d.name.toLowerCase() === wanted);
  if (!found) throw new GraphError(404, 'library_not_found', target.library);
  return found.id;
}

const toItem = (parent: string, d: DriveItem): MountItem => ({
  name: d.name,
  path: joinPath(parent, d.name),
  type: d.folder ? 'folder' : 'file',
  sizeBytes: d.folder ? null : (d.size ?? null),
  mime: d.file?.mimeType ?? null,
  modifiedAt: d.lastModifiedDateTime ?? null,
});

export function graphDriveAdapter(creds: AppCredentials, driveId: string, rootPath: string): MountAdapter {
  const full = (path: string) => joinPath(rootPath, path);
  return {
    async list(path) {
      const items = await graphAll<DriveItem>(
        creds,
        `${itemRef(driveId, full(path))}/children?$top=200&${SELECT}`,
        5000,
      );
      return items
        .map((d) => toItem(path, d))
        .sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'folder' ? -1 : 1));
    },
    async read(path) {
      const meta = await graph<DriveItem>(creds, `${itemRef(driveId, full(path))}?${SELECT}`);
      if (meta.folder) throw new GraphError(400, 'is_folder', path);
      // Graph answers with a redirect to a pre-authenticated download URL; fetch follows it.
      const res = await graphRaw(creds, `${itemRef(driveId, full(path))}/content`);
      return {
        name: meta.name,
        mime: meta.file?.mimeType ?? null,
        size: meta.size ?? null,
        body: Buffer.from(await res.arrayBuffer()),
      };
    },
    async write(folder, name, content, mime) {
      const target = full(joinPath(folder, name));
      if (content.length <= SIMPLE_UPLOAD) {
        const res = await graphRaw(
          creds,
          `/drives/${driveId}/root:/${encodePath(target)}:/content?@microsoft.graph.conflictBehavior=rename`,
          { method: 'PUT', raw: content, headers: { 'content-type': mime ?? 'application/octet-stream' } },
        );
        return toItem(folder, (await res.json()) as DriveItem);
      }
      const session = await graph<{ uploadUrl: string }>(
        creds,
        `/drives/${driveId}/root:/${encodePath(target)}:/createUploadSession`,
        { method: 'POST', body: { item: { '@microsoft.graph.conflictBehavior': 'rename' } } },
      );
      let last: DriveItem | null = null;
      for (let start = 0; start < content.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, content.length);
        // The upload URL is pre-authenticated: no bearer header on these requests.
        const res = await msFetch(session.uploadUrl, {
          method: 'PUT',
          headers: {
            'content-length': String(end - start),
            'content-range': `bytes ${start}-${end - 1}/${content.length}`,
          },
          body: content.subarray(start, end),
        });
        if (!res.ok) throw new GraphError(res.status, 'upload_failed', `chunk ${start}`);
        if (res.status === 200 || res.status === 201) last = (await res.json()) as DriveItem;
      }
      if (!last) throw new GraphError(502, 'upload_incomplete', target);
      return toItem(folder, last);
    },
    async mkdir(folder, name) {
      const created = await graph<DriveItem>(creds, `${itemRef(driveId, full(folder))}/children`, {
        method: 'POST',
        body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' },
      });
      return toItem(folder, created);
    },
    async check() {
      await graph(creds, `${itemRef(driveId, full(''))}?$select=id`);
    },
  };
}

