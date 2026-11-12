import { and, eq, inArray } from 'drizzle-orm';
import { blobs, nodeVersions, pages, type DbOrTx } from '@crewhall/db';
import type { Readable } from 'node:stream';
import { pageIdFromRef } from '@crewhall/shared';
import type { Storage } from '../../../storage/s3';
import { loadNode, type DriveActor } from '../../drive/access';
import { loadPage } from '../access';
import { docFromState, docToJson, walk, type PMDoc } from '../doc';
import { pageTree } from '../pages';

/**
 * What an export contains (roadmap 6): the page, its sub-pages the person can open (with
 * `children`), and the Drive files their bodies use as `node:<id>` (images, attachments,
 * embedded files) that the person can open. Each page gets a file path that mirrors the tree:
 * `Mimari`, `Mimari/Kilit stratejisi`; files go to `ekler/`.
 */

export const LIMITS = {
  pages: 500,
  /** One file larger than this is left out (and listed). */
  fileBytes: 50 * 1024 * 1024,
  /** All files together; the rest is left out (and listed). */
  totalBytes: 250 * 1024 * 1024,
};

export interface ExportPage {
  id: string;
  name: string;
  icon: string | null;
  doc: PMDoc;
  /** File path without extension, `/`-separated. */
  path: string;
}

export interface ExportFile {
  id: string;
  name: string;
  mime: string;
  data: Buffer;
  /** `ekler/<name>` inside a ZIP. */
  path: string;
  isImage: boolean;
}

export interface ExportSet {
  pages: ExportPage[];
  files: Map<string, ExportFile>;
  /** Names of other Hub nodes the bodies embed or mention (link labels). */
  nodeNames: Map<string, string>;
  skipped: string[];
}

const NODE_REF = /^node:([0-9a-f-]{36})$/i;

/** A file or folder name that works on Windows, macOS and Linux. */
export function safeName(name: string, fallback: string) {
  const clean = [...name]
    // Control characters cannot be in file names either.
    .map((ch) => (ch.charCodeAt(0) < 32 ? '-' : ch))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return clean || fallback;
}

/** `name`, `name (2)`, … unique (case-insensitive) within `taken`. */
function unique(taken: Set<string>, name: string, ext = '') {
  let n = 1;
  let candidate = `${name}${ext}`;
  while (taken.has(candidate.toLowerCase())) candidate = `${name} (${++n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

async function toBuffer(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      stream.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** `node:<id>` sources, embedded nodes and node mentions of a body. */
export function nodeRefs(doc: PMDoc) {
  const files = new Set<string>();
  const others = new Set<string>();
  walk(doc, (n) => {
    const src =
      n.type === 'image' || n.type === 'video' ? NODE_REF.exec(String(n.attrs?.src ?? '')) : null;
    if (src) files.add(src[1]!.toLowerCase());
    if (n.type === 'embed' && typeof n.attrs?.nodeId === 'string') files.add(n.attrs.nodeId);
    if (n.type === 'mention' && n.attrs?.kind === 'node' && typeof n.attrs.id === 'string') {
      others.add(n.attrs.id);
    }
    for (const m of n.marks ?? []) {
      const href = m.type === 'link' ? String(m.attrs?.href ?? '') : '';
      const file = NODE_REF.exec(href);
      if (file) files.add(file[1]!.toLowerCase());
    }
  });
  return { files, others };
}

export async function collectExport(
  deps: { db: DbOrTx; storage: Storage | null },
  a: DriveActor,
  rootId: string,
  children: boolean,
  opts: { untitled: string; attachments: string },
): Promise<ExportSet> {
  const { db } = deps;
  const root = await loadPage(db, a, rootId);

  // The pages: the root, then (with children) every visible sub-page, depth first in tree order.
  const order: { id: string; name: string; icon: string | null; parentPath: string | null }[] = [
    { id: root.node.id, name: root.node.name, icon: root.page.icon, parentPath: null },
  ];
  if (children) {
    const tree = await pageTree(db, a, root.space.id);
    const kids = new Map<string, typeof tree.items>();
    for (const item of tree.items) {
      if (!item.parentId) continue;
      kids.set(item.parentId, [...(kids.get(item.parentId) ?? []), item]);
    }
    for (const list of kids.values()) {
      list.sort((x, y) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0));
    }
    const visit = (id: string) => {
      for (const k of kids.get(id) ?? []) {
        if (order.length >= LIMITS.pages) return;
        order.push({ id: k.id, name: k.name, icon: k.icon, parentPath: id });
        visit(k.id);
      }
    };
    visit(root.node.id);
  }

  const rows = await db
    .select({ nodeId: pages.nodeId, ydoc: pages.ydoc })
    .from(pages)
    .where(
      inArray(
        pages.nodeId,
        order.map((o) => o.id),
      ),
    );
  const docs = new Map(rows.map((r) => [r.nodeId, docToJson(docFromState(r.ydoc))]));

  const paths = new Map<string, string>();
  const takenIn = new Map<string, Set<string>>();
  const exported: ExportPage[] = [];
  for (const o of order) {
    const dir = o.parentPath ? paths.get(o.parentPath)! : '';
    const taken = takenIn.get(dir) ?? new Set<string>([opts.attachments.toLowerCase()]);
    takenIn.set(dir, taken);
    const name = unique(taken, safeName(o.name, opts.untitled));
    const path = dir ? `${dir}/${name}` : name;
    paths.set(o.id, path);
    exported.push({
      id: o.id,
      name: o.name,
      icon: o.icon,
      doc: docs.get(o.id) ?? { type: 'doc', content: [] },
      path,
    });
  }

  // Drive files and other nodes the bodies point at, kept only where the person has access.
  const fileIds = new Set<string>();
  const otherIds = new Set<string>();
  for (const p of exported) {
    const refs = nodeRefs(p.doc);
    refs.files.forEach((id) => fileIds.add(id));
    refs.others.forEach((id) => otherIds.add(id));
  }
  const visible = async (id: string) => {
    try {
      return (await loadNode(db, a, id)).node;
    } catch {
      return null;
    }
  };

  const nodeNames = new Map<string, string>();
  for (const id of otherIds) {
    const n = await visible(id);
    if (n) nodeNames.set(id, n.name);
  }

  const files = new Map<string, ExportFile>();
  const skipped: string[] = [];
  const takenFiles = new Set<string>();
  let total = 0;
  for (const id of fileIds) {
    const n = await visible(id);
    if (!n) continue;
    nodeNames.set(id, n.name);
    if (n.type !== 'file' || !n.currentVersionId || !deps.storage) continue;
    const [row] = await db
      .select({
        key: blobs.storageKey,
        size: blobs.size,
        mime: blobs.mime,
        status: blobs.status,
      })
      .from(nodeVersions)
      .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
      .where(and(eq(nodeVersions.id, n.currentVersionId)));
    if (!row || row.status === 'quarantined') continue;
    if (row.size > LIMITS.fileBytes || total + row.size > LIMITS.totalBytes) {
      skipped.push(n.name);
      continue;
    }
    const data = await deps.storage
      .getStream(row.key)
      .then((stream) => toBuffer(stream, LIMITS.fileBytes))
      .catch(() => null);
    if (!data) {
      skipped.push(n.name);
      continue;
    }
    total += data.length;
    const mime = n.mime ?? row.mime ?? 'application/octet-stream';
    const dot = n.name.lastIndexOf('.');
    const base = dot > 0 ? n.name.slice(0, dot) : n.name;
    const ext = dot > 0 ? n.name.slice(dot) : '';
    files.set(id, {
      id,
      name: n.name,
      mime,
      data,
      path: `${opts.attachments}/${unique(takenFiles, safeName(base, 'dosya'), ext)}`,
      isImage: /^image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp)$/i.test(mime),
    });
  }

  return { pages: exported, files, nodeNames, skipped };
}

/** The page id an href points at (`/p/<slug>-<id>`, a full hub URL, `crewhall://page/<id>`). */
export function pageIdOfHref(href: string): string | null {
  const internal =
    /^\/p\//.test(href) || /^crewhall:\/\/page\//.test(href) || /\/p\/[^/?#]+$/.test(href);
  return internal ? pageIdFromRef(href.split(/[?#]/)[0]!) : null;
}

export const fileIdOfRef = (ref: string) => NODE_REF.exec(ref)?.[1]?.toLowerCase() ?? null;
