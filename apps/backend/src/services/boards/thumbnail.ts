import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  blobDerivatives,
  blobs,
  drawingFiles,
  drawings,
  newId,
  nodes,
  type Db,
} from '@crewhall/db';
import sharp from 'sharp';
import type { Logger } from '../../logger';
import type { Storage } from '../../storage/s3';
import { renderPreviews } from '../../jobs/preview';
import { docFrom, sceneElements, type Element } from './ydoc';
import { drawingsEnabled } from './module';
import type { Bus } from '../../realtime/bus';
import { publishBoardEvent } from './integrations';

/**
 * Drawing thumbnails (doc 17 §4 "Küçük resim worker'da üretilir"). Excalidraw needs a DOM
 * to export, so the worker draws the scene itself as SVG: shapes with Crewhall's flat look
 * (roughness 0), text in Nunito, images embedded. sharp rasterises it to PNG; the usual
 * thumb_256 / thumb_1024 derivatives hang off a dedicated blob that Drive previews read.
 */

const PAD = 24;
const MAX_IMAGES = 12;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

type Pt = [number, number];
const points = (el: Element): Pt[] =>
  Array.isArray(el.points)
    ? (el.points as unknown[])
        .filter((p): p is Pt => Array.isArray(p) && p.length >= 2)
        .map((p) => [num(p[0]), num(p[1])] as Pt)
    : [];

/** Axis-aligned bounds of the scene, rotation ignored (good enough for a thumbnail). */
export function sceneBounds(elements: Element[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const x = num(el.x);
    const y = num(el.y);
    const pts = points(el);
    if (pts.length) {
      for (const [px, py] of pts) {
        minX = Math.min(minX, x + px);
        minY = Math.min(minY, y + py);
        maxX = Math.max(maxX, x + px);
        maxY = Math.max(maxY, y + py);
      }
    } else {
      const w = num(el.width);
      const h = num(el.height);
      minX = Math.min(minX, x, x + w);
      minY = Math.min(minY, y, y + h);
      maxX = Math.max(maxX, x, x + w);
      maxY = Math.max(maxY, y, y + h);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 320, height: 200 };
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function strokeAttrs(el: Element) {
  const stroke = str(el.strokeColor, '#1e1e1e');
  const width = num(el.strokeWidth, 2);
  const dash =
    el.strokeStyle === 'dashed'
      ? ` stroke-dasharray="${width * 4} ${width * 3}"`
      : el.strokeStyle === 'dotted'
        ? ` stroke-dasharray="${width} ${width * 2}"`
        : '';
  return `stroke="${esc(stroke)}" stroke-width="${width}"${dash} stroke-linecap="round" stroke-linejoin="round"`;
}

function fill(el: Element) {
  const bg = str(el.backgroundColor, 'transparent');
  if (bg === 'transparent') return 'fill="none"';
  // Hachure and cross-hatch read as a lighter fill at thumbnail size.
  const op = el.fillStyle === 'solid' ? 1 : 0.45;
  return `fill="${esc(bg)}" fill-opacity="${op}"`;
}

function transform(el: Element) {
  const angle = num(el.angle);
  if (!angle) return '';
  const cx = num(el.x) + num(el.width) / 2;
  const cy = num(el.y) + num(el.height) / 2;
  return ` transform="rotate(${(angle * 180) / Math.PI} ${cx} ${cy})"`;
}

function arrowHead(el: Element, pts: Pt[], end: 'start' | 'end') {
  if (pts.length < 2) return '';
  const x0 = num(el.x);
  const y0 = num(el.y);
  const [a, b] = end === 'end' ? [pts.at(-2)!, pts.at(-1)!] : [pts[1]!, pts[0]!];
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const len = 10 + num(el.strokeWidth, 2) * 2;
  const tip: Pt = [x0 + b[0], y0 + b[1]];
  const l: Pt = [tip[0] - len * Math.cos(ang - 0.45), tip[1] - len * Math.sin(ang - 0.45)];
  const r: Pt = [tip[0] - len * Math.cos(ang + 0.45), tip[1] - len * Math.sin(ang + 0.45)];
  return `<polyline points="${l.join(',')} ${tip.join(',')} ${r.join(',')}" fill="none" ${strokeAttrs({ ...el, strokeStyle: 'solid' })}/>`;
}

function textSvg(el: Element) {
  const size = num(el.fontSize, 20);
  const lines = str(el.text, '').split('\n');
  const align = el.textAlign === 'center' ? 'middle' : el.textAlign === 'right' ? 'end' : 'start';
  const x =
    align === 'middle'
      ? num(el.x) + num(el.width) / 2
      : align === 'end'
        ? num(el.x) + num(el.width)
        : num(el.x);
  const lh = size * num(el.lineHeight, 1.25);
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" y="${num(el.y) + size + i * lh}">${esc(line)}</tspan>`)
    .join('');
  return `<text font-family="Nunito, 'Nunito Variable', sans-serif" font-size="${size}" fill="${esc(str(el.strokeColor, '#1e1e1e'))}" text-anchor="${align}"${transform(el)}>${tspans}</text>`;
}

/** SVG of the scene; `images` maps Excalidraw file ids to data URLs. */
export function sceneSvg(elements: Element[], images: Map<string, string> = new Map()) {
  const b = sceneBounds(elements);
  const parts: string[] = [];
  for (const el of elements) {
    const x = num(el.x);
    const y = num(el.y);
    const w = num(el.width);
    const h = num(el.height);
    const opacity = num(el.opacity, 100) / 100;
    const open = `<g opacity="${opacity}">`;
    let body = '';
    switch (el.type) {
      case 'rectangle':
      case 'frame':
      case 'magicframe':
      case 'embeddable':
      case 'iframe': {
        const rx = el.roundness ? Math.min(Math.abs(w), Math.abs(h)) * 0.12 : 0;
        const dashed = el.type === 'frame' ? { ...el, strokeStyle: 'dashed' } : el;
        body = `<rect x="${Math.min(x, x + w)}" y="${Math.min(y, y + h)}" width="${Math.abs(w)}" height="${Math.abs(h)}" rx="${rx}" ${fill(el)} ${strokeAttrs(dashed)}${transform(el)}/>`;
        break;
      }
      case 'ellipse':
        body = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.abs(w / 2)}" ry="${Math.abs(h / 2)}" ${fill(el)} ${strokeAttrs(el)}${transform(el)}/>`;
        break;
      case 'diamond':
        body = `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${fill(el)} ${strokeAttrs(el)}${transform(el)}/>`;
        break;
      case 'line':
      case 'arrow':
      case 'freedraw': {
        const pts = points(el);
        if (pts.length === 0) break;
        const d = pts.map((p) => `${x + p[0]},${y + p[1]}`).join(' ');
        const closed = el.type === 'line' && pts.length > 2 && el.backgroundColor !== 'transparent';
        body = closed
          ? `<polygon points="${d}" ${fill(el)} ${strokeAttrs(el)}/>`
          : `<polyline points="${d}" fill="none" ${strokeAttrs(el)}/>`;
        if (el.type === 'arrow') {
          if (el.endArrowhead !== null) body += arrowHead(el, pts, 'end');
          if (el.startArrowhead) body += arrowHead(el, pts, 'start');
        }
        break;
      }
      case 'text':
        body = textSvg(el);
        break;
      case 'image': {
        const src = typeof el.fileId === 'string' ? images.get(el.fileId) : undefined;
        body = src
          ? `<image href="${esc(src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"${transform(el)}/>`
          : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e7e7e5" stroke="#c9c9c6"/>`;
        break;
      }
      default:
        break;
    }
    if (body) parts.push(`${open}${body}</g>`);
  }
  const vx = b.minX - PAD;
  const vy = b.minY - PAD;
  const vw = b.width + PAD * 2;
  const vh = b.height + PAD * 2;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}"><rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#ffffff"/>${parts.join('')}</svg>`,
    width: vw,
    height: vh,
  };
}

/** Rasterises the scene SVG to a PNG at most 1600 px on its long side. */
export async function scenePng(elements: Element[], images?: Map<string, string>) {
  const { svg, width, height } = sceneSvg(elements, images);
  const scale = Math.min(4, 1600 / Math.max(width, height));
  const density = Math.max(1, Math.min(600, 72 * scale));
  return sharp(Buffer.from(svg), { density, limitInputPixels: 100_000_000 })
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

export interface ThumbnailDeps {
  db: Db;
  storage: Storage | null;
  logger: Logger;
  /** Tells open lists and Drive grids that the preview changed. */
  bus?: Bus | null;
}

async function embeddedImages(deps: ThumbnailDeps, nodeId: string, elements: Element[]) {
  const ids = [
    ...new Set(
      elements
        .filter((e) => e.type === 'image' && typeof e.fileId === 'string')
        .map((e) => e.fileId as string),
    ),
  ].slice(0, MAX_IMAGES);
  const out = new Map<string, string>();
  if (!ids.length || !deps.storage) return out;
  const rows = await deps.db
    .select({ fileId: drawingFiles.fileId, mime: drawingFiles.mime, key: blobs.storageKey })
    .from(drawingFiles)
    .innerJoin(blobs, eq(blobs.id, drawingFiles.blobId))
    .where(and(eq(drawingFiles.nodeId, nodeId), inArray(drawingFiles.fileId, ids)));
  for (const r of rows) {
    if (r.mime === 'image/svg+xml') continue; // never inline foreign SVG into ours
    try {
      const chunks: Buffer[] = [];
      for await (const c of (await deps.storage.getStream(r.key)) as AsyncIterable<Buffer>) {
        chunks.push(c);
      }
      // Shrink first: the thumbnail never needs more than a few hundred pixels per image.
      const small = await sharp(Buffer.concat(chunks))
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      out.set(r.fileId, `data:image/png;base64,${small.toString('base64')}`);
    } catch (err) {
      deps.logger.warn({ err, nodeId, fileId: r.fileId }, 'drawing image skipped in thumbnail');
    }
  }
  return out;
}

/**
 * drawing.thumbnail: renders the current scene when it changed since the last thumbnail.
 * The previous thumbnail blob is released (ref 0, purged with its derivatives).
 */
export async function renderDrawingThumbnail(deps: ThumbnailDeps, nodeId: string) {
  const { db, storage } = deps;
  if (!storage) return;
  const [row] = await db.select().from(drawings).where(eq(drawings.nodeId, nodeId));
  if (!row) return;
  if (row.thumbnailBlobId && row.thumbnailRev >= row.sceneRev) return;
  if (!(await drawingsEnabled(db, row.orgId))) return;
  const rev = row.sceneRev;
  const elements = sceneElements(docFrom(row.ydoc));
  const png = await scenePng(elements, await embeddedImages(deps, nodeId, elements));
  const outputs = await renderPreviews(png, 'image');

  const blobId = newId();
  const storageKey = `orgs/${row.orgId}/blobs/${blobId}`;
  await storage.put(storageKey, png, 'image/png');
  for (const out of outputs)
    await storage.put(`${storageKey}/${out.kind}.webp`, out.data, 'image/webp');

  const kept = await db.transaction(async (tx) => {
    await tx.insert(blobs).values({
      id: blobId,
      orgId: row.orgId,
      size: png.length,
      mime: 'image/png',
      storageKey,
      status: 'ready',
      previewStatus: 'ready',
      refCount: 1,
    });
    for (const out of outputs) {
      await tx.insert(blobDerivatives).values({
        orgId: row.orgId,
        blobId,
        kind: out.kind,
        storageKey: `${storageKey}/${out.kind}.webp`,
        mime: 'image/webp',
        width: out.width,
        height: out.height,
        size: out.data.length,
      });
    }
    // Only move forward: a render of a revision that already has a thumbnail (a concurrent
    // run of the same scene, or an older one finishing late) is dropped, so a rerun is a no-op.
    const [locked] = await tx
      .select()
      .from(drawings)
      .where(eq(drawings.nodeId, nodeId))
      .for('update');
    const previous = locked?.thumbnailBlobId ?? null;
    if (!locked || (locked.thumbnailBlobId && locked.thumbnailRev >= rev)) {
      await tx
        .update(blobs)
        .set({ refCount: 0, orphanedAt: new Date() })
        .where(eq(blobs.id, blobId));
      return false;
    }
    await tx
      .update(drawings)
      .set({ thumbnailBlobId: blobId, thumbnailRev: rev })
      .where(eq(drawings.nodeId, nodeId));
    if (previous) {
      await tx
        .update(blobs)
        .set({ refCount: 0, orphanedAt: new Date() })
        .where(eq(blobs.id, previous));
    }
    return true;
  });
  if (!kept) return;
  const [node] = await db
    .select({ spaceId: nodes.spaceId })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  if (node) {
    await publishBoardEvent(
      deps,
      { type: 'drawing.thumbnail', nodeId, rev },
      { orgId: row.orgId, spaceId: node.spaceId, nodeId },
    );
  }
}

/** Drawings whose thumbnail lags behind (the throttled send missed it): for the sweep. */
export async function staleThumbnails(db: Db, limit = 50) {
  const rows = await db
    .select({ nodeId: drawings.nodeId })
    .from(drawings)
    .where(
      and(
        sql`${drawings.thumbnailRev} < ${drawings.sceneRev}`,
        lt(drawings.updatedAt, new Date(Date.now() - 20_000)),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.nodeId);
}
