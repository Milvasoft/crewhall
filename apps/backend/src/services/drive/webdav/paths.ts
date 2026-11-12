import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { nodes, spaces, type DbOrTx } from '@crewhall/db';
import { can, type SpaceRole } from '@crewhall/shared';
import {
  nodeResource,
  reachableSpaceIds,
  roleForPath,
  spaceRoleOf,
  userSharePaths,
  type NodeRow,
  type SpaceRow,
} from '../access';
import type { DavSession } from './auth';

/** Where WebDAV lives (Caddyfile and the Vite proxy route it to the api). */
export const DAV_PREFIX = '/dav';

/** Only folders and files have bytes; pages, boards and drawings stay in the web app. */
export const DAV_TYPES = ['folder', 'file'] as const;

export interface DavSpace {
  space: SpaceRow;
  /** Folder name under /dav: the space name, made unique among the person's spaces. */
  label: string;
  role: SpaceRole | null;
  sharePaths: { path: string; role: 'viewer' | 'editor' }[];
}

export type Resolved =
  | { kind: 'root' }
  | { kind: 'space'; space: DavSpace }
  | { kind: 'node'; space: DavSpace; node: NodeRow; role: SpaceRole }
  /** The parent exists, the last segment does not (PUT, MKCOL, LOCK, MOVE targets). */
  | { kind: 'missing'; space: DavSpace; parent: NodeRow | null; name: string }
  /** Some ancestor is missing too (409 for writes, 404 for reads). */
  | { kind: 'orphan' };

const label = (name: string) => name.replace(/[/\\]/g, '-').trim() || '-';

/** The spaces the token may reach, as root folders; the personal space first. */
export async function davSpaces(db: DbOrTx, s: DavSession): Promise<DavSpace[]> {
  let ids = await reachableSpaceIds(db, s.a);
  if (s.principal.spaceIds) {
    const allowed = new Set(s.principal.spaceIds);
    ids = ids.filter((id) => allowed.has(id));
  }
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(spaces)
    .where(and(inArray(spaces.id, ids), eq(spaces.orgId, s.a.org.id), isNull(spaces.deletedAt)))
    .orderBy(asc(spaces.kind), asc(spaces.name), asc(spaces.id));
  const out: DavSpace[] = [];
  const taken = new Set<string>();
  for (const space of rows) {
    let name = label(space.name);
    if (taken.has(name.toLocaleLowerCase('tr'))) name = `${name} (${space.slug})`;
    taken.add(name.toLocaleLowerCase('tr'));
    out.push({
      space,
      label: name,
      role: await spaceRoleOf(db, space.id, s.a.userId),
      sharePaths: await userSharePaths(db, space.id, s.a.userId),
    });
  }
  return out;
}

/** Effective role on a node of a space, or null when the person may not see it. */
export function davRole(s: DavSession, space: DavSpace, path: string): SpaceRole | null {
  const role = roleForPath(space.role, space.sharePaths, path);
  return role && can(s.a.actor, 'space.view', nodeResource(s.a, role)) ? role : null;
}

/** "/dav/Ekip/Raporlar/a.pdf" → ["Ekip", "Raporlar", "a.pdf"]; null when not under /dav. */
export function davSegments(pathname: string): string[] | null {
  if (pathname !== DAV_PREFIX && !pathname.startsWith(`${DAV_PREFIX}/`)) return null;
  try {
    return pathname
      .slice(DAV_PREFIX.length)
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
}

export function davHref(segments: string[], collection: boolean): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  const base = path ? `${DAV_PREFIX}/${path}` : DAV_PREFIX;
  return collection ? `${base}/` : base;
}

/** Live child of a folder (or the space root) by exact name, folders and files only. */
export async function childByName(
  db: DbOrTx,
  spaceId: string,
  parentId: string | null,
  name: string,
) {
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.spaceId, spaceId),
        parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
        eq(nodes.name, name),
        isNull(nodes.deletedAt),
        inArray(nodes.type, [...DAV_TYPES]),
      ),
    );
  return row ?? null;
}

export async function resolveDav(
  db: DbOrTx,
  s: DavSession,
  segments: string[],
  list?: DavSpace[],
): Promise<Resolved> {
  if (segments.length === 0) return { kind: 'root' };
  const all = list ?? (await davSpaces(db, s));
  const [first, ...rest] = segments;
  const space = all.find((x) => x.label === first);
  if (!space) return { kind: 'orphan' };
  if (rest.length === 0) return { kind: 'space', space };
  let parent: NodeRow | null = null;
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]!;
    const last = i === rest.length - 1;
    const row = await childByName(db, space.space.id, parent?.id ?? null, name);
    const role = row ? davRole(s, space, row.path) : null;
    if (!row || !role) return last ? { kind: 'missing', space, parent, name } : { kind: 'orphan' };
    if (last) return { kind: 'node', space, node: row, role };
    if (row.type !== 'folder') return { kind: 'orphan' };
    parent = row;
  }
  return { kind: 'orphan' };
}

/** Children of a folder or a space root the person can see. */
export async function davChildren(
  db: DbOrTx,
  s: DavSession,
  space: DavSpace,
  parentId: string | null,
) {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.spaceId, space.space.id),
        parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
        isNull(nodes.deletedAt),
        inArray(nodes.type, [...DAV_TYPES]),
      ),
    )
    .orderBy(asc(nodes.name), asc(nodes.id))
    .limit(10_000);
  return rows.filter((r) => davRole(s, space, r.path) !== null);
}
