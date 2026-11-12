import { type DriveNode, pagePath, paths, withQuery } from '@crewhall/shared';

/**
 * Drive addresses: `/drive/:space` is the root, `/drive/:space/folder/:folderId` a folder;
 * `?preview=` opens the viewer, `?detail=` the detail panel, `?view=grid` the grid view.
 */

export type DriveSearch = { preview?: string; detail?: string; view?: 'grid' };

export type DriveLocation =
  | { to: '/drive/$spaceSlug'; params: { spaceSlug: string }; search: DriveSearch }
  | {
      to: '/drive/$spaceSlug/folder/$folderId';
      params: { spaceSlug: string; folderId: string };
      search: DriveSearch;
    };

export function folderLocation(
  spaceSlug: string,
  folderId: string | null,
  search: DriveSearch = {},
): DriveLocation {
  return folderId
    ? { to: '/drive/$spaceSlug/folder/$folderId', params: { spaceSlug, folderId }, search }
    : { to: '/drive/$spaceSlug', params: { spaceSlug }, search };
}

/** Where a node opens: folders and pages list their children, files open in the viewer. */
export function nodeLocation(
  node: Pick<DriveNode, 'id' | 'type' | 'parentId'>,
  spaceSlug: string,
): DriveLocation {
  if (node.type === 'folder') return folderLocation(spaceSlug, node.id);
  if (node.type === 'file') return folderLocation(spaceSlug, node.parentId, { preview: node.id });
  return folderLocation(spaceSlug, node.parentId, { detail: node.id });
}

/** The address of a node as it opens: its own page for a page, board or drawing. */
export function nodeOpenHref(node: DriveNode, spaceSlug: string): string {
  if (node.type === 'page') return `${window.location.origin}${pagePath(node)}`;
  if (node.type === 'board') return `${window.location.origin}${paths.board(node.id)}`;
  if (node.type === 'drawing') return `${window.location.origin}${paths.drawing(node.id)}`;
  return nodeHref(node, spaceSlug);
}

export function nodeHref(
  node: Pick<DriveNode, 'id' | 'type' | 'parentId'>,
  spaceSlug: string,
): string {
  const loc = nodeLocation(node, spaceSlug);
  const path =
    loc.to === '/drive/$spaceSlug'
      ? paths.driveSpace(spaceSlug)
      : paths.driveFolder(spaceSlug, loc.params.folderId);
  return `${window.location.origin}${withQuery(path, loc.search)}`;
}
