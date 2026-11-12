import { type OrgChartNode } from '@crewhall/shared';

/**
 * Org chart (sonraki-isler): the tree, its groups and its export as an image or a PDF. Pure
 * functions; the view draws the same rows the export prints.
 */

export type ChartGroup = 'manager' | 'department' | 'team';

export interface ChartSection {
  /** Department or team; null for the plain manager tree (and for "not given"). */
  key: string | null;
  /** Top people of the section: no manager, or a manager outside the section. */
  roots: OrgChartNode[];
  size: number;
}

export interface ChartModel {
  byId: Map<string, OrgChartNode>;
  /** Reports of a person within the same section. */
  childrenOf: (id: string) => OrgChartNode[];
  sections: ChartSection[];
}

const byName = (a: OrgChartNode, b: OrgChartNode) => a.user.name.localeCompare(b.user.name, 'tr');

export function chartModel(items: OrgChartNode[], group: ChartGroup): ChartModel {
  const byId = new Map(items.map((n) => [n.user.id, n]));
  const keyOf = (n: OrgChartNode) =>
    group === 'department' ? n.department : group === 'team' ? (n.team ?? null) : null;
  const children = new Map<string, OrgChartNode[]>();
  for (const n of items) {
    const m = n.managerId ? byId.get(n.managerId) : undefined;
    if (!m || keyOf(m) !== keyOf(n)) continue;
    children.set(m.user.id, [...(children.get(m.user.id) ?? []), n]);
  }
  for (const list of children.values()) list.sort(byName);
  const sections = new Map<string | null, OrgChartNode[]>();
  for (const n of items) {
    const k = keyOf(n);
    if (!sections.has(k)) sections.set(k, []);
    const m = n.managerId ? byId.get(n.managerId) : undefined;
    if (!m || keyOf(m) !== k) sections.get(k)!.push(n);
  }
  const size = (k: string | null) => items.filter((n) => keyOf(n) === k).length;
  return {
    byId,
    childrenOf: (id) => children.get(id) ?? [],
    sections: [...sections]
      .map(([key, roots]) => ({ key, roots: roots.sort(byName), size: size(key) }))
      // Named groups first, alphabetically; people without one last.
      .sort((a, b) =>
        a.key === b.key
          ? 0
          : a.key === null
            ? 1
            : b.key === null
              ? -1
              : a.key.localeCompare(b.key, 'tr'),
      ),
  };
}

/** The person and everyone under them (they cannot become the person's manager). */
export function descendantsOf(items: OrgChartNode[], id: string): Set<string> {
  const reports = new Map<string, string[]>();
  for (const n of items) {
    if (n.managerId) reports.set(n.managerId, [...(reports.get(n.managerId) ?? []), n.user.id]);
  }
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    for (const r of reports.get(stack.pop()!) ?? []) {
      if (out.has(r)) continue;
      out.add(r);
      stack.push(r);
    }
  }
  return out;
}

/** Nobody has a manager yet: the chart is a flat list and needs explaining. */
export const chartIsFlat = (items: OrgChartNode[]) =>
  items.length > 1 && items.every((n) => !n.managerId);

// ---- export --------------------------------------------------------------------------------

export interface ExportRow {
  depth: number;
  /** A section heading (department or team) instead of a person. */
  heading: boolean;
  name: string;
  sub: string;
}

/** Every row of the chart, fully expanded, in reading order. */
export function exportRows(model: ChartModel, noGroup: string): ExportRow[] {
  const rows: ExportRow[] = [];
  const walk = (n: OrgChartNode, depth: number, seen: Set<string>) => {
    if (seen.has(n.user.id)) return;
    seen.add(n.user.id);
    rows.push({
      depth,
      heading: false,
      name: n.user.name,
      sub: [n.title, n.department].filter(Boolean).join(' · '),
    });
    for (const c of model.childrenOf(n.user.id)) walk(c, depth + 1, seen);
  };
  const grouped = model.sections.some((s) => s.key !== null) || model.sections.length > 1;
  for (const s of model.sections) {
    if (grouped) {
      rows.push({ depth: 0, heading: true, name: s.key ?? noGroup, sub: String(s.size) });
    }
    for (const r of s.roots) walk(r, grouped ? 1 : 0, new Set());
  }
  return rows;
}

const ROW = 44;
const INDENT = 28;
const PAD = 32;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A printable SVG (light, system fonts: an SVG drawn as an image loads no web fonts). */
export function chartSvg(rows: ExportRow[], title: string) {
  const width = Math.max(
    560,
    PAD * 2 +
      Math.max(
        0,
        ...rows.map((r) => r.depth * INDENT + 40 + Math.max(r.name.length, r.sub.length) * 7.2),
      ),
  );
  const height = PAD * 2 + 40 + rows.length * ROW;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${height}" viewBox="0 0 ${Math.ceil(width)} ${height}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<g font-family="Segoe UI, Helvetica, Arial, sans-serif">`,
    `<text x="${PAD}" y="${PAD + 18}" font-size="18" font-weight="700" fill="#141516">${esc(title)}</text>`,
  ];
  rows.forEach((r, i) => {
    const x = PAD + r.depth * INDENT;
    const y = PAD + 40 + i * ROW;
    if (r.depth > 0 && !r.heading) {
      // The line up to the manager's row.
      parts.push(
        `<path d="M${x - 14} ${y + 4} V${y + ROW / 2} H${x - 2}" fill="none" stroke="#c8c9cc" stroke-width="1.2"/>`,
      );
    }
    if (r.heading) {
      parts.push(
        `<text x="${x}" y="${y + 26}" font-size="13" font-weight="700" fill="#5b5d61" letter-spacing="0.6">${esc(r.name.toLocaleUpperCase('tr'))} · ${esc(r.sub)}</text>`,
      );
      return;
    }
    const initials = r.name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.charAt(0))
      .join('')
      .toLocaleUpperCase('tr');
    parts.push(
      `<circle cx="${x + 14}" cy="${y + ROW / 2}" r="14" fill="#FBC419"/>`,
      `<text x="${x + 14}" y="${y + ROW / 2 + 4}" font-size="11" font-weight="700" text-anchor="middle" fill="#141516">${esc(initials)}</text>`,
      `<text x="${x + 36}" y="${y + (r.sub ? 18 : 26)}" font-size="13" font-weight="600" fill="#141516">${esc(r.name)}</text>`,
    );
    if (r.sub) {
      parts.push(
        `<text x="${x + 36}" y="${y + 35}" font-size="11" fill="#5b5d61">${esc(r.sub)}</text>`,
      );
    }
  });
  parts.push('</g></svg>');
  return { svg: parts.join(''), width: Math.ceil(width), height };
}

/**
 * A one-page PDF holding a JPEG (DCTDecode needs no image library): the page is the image's
 * size in points, so it prints at its natural size.
 */
export function pdfFromJpeg(
  jpeg: Uint8Array,
  image: { width: number; height: number },
  page: { width: number; height: number },
): Uint8Array<ArrayBuffer> {
  const { width, height } = page;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (c: Uint8Array | string) => {
    const bytes = typeof c === 'string' ? enc.encode(c) : c;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string | (Uint8Array | string)[]) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    for (const part of Array.isArray(body) ? body : [body]) push(part);
    push('\nendobj\n');
  };
  const draw = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  push('%PDF-1.4\n%\xC7\xEC\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  object(4, [
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    '\nendstream',
  ]);
  object(5, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n`);
  for (let n = 1; n <= 5; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Draws the SVG on a canvas (2× for sharp text). */
async function render(svg: string, width: number, height: number) {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function downloadChart(
  kind: 'png' | 'pdf',
  chart: { svg: string; width: number; height: number },
  name: string,
) {
  const canvas = await render(chart.svg, chart.width, chart.height);
  if (kind === 'png') {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (blob) save(blob, `${name}.png`);
    return;
  }
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) return;
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  // The page keeps the chart's size; the image inside is the 2× drawing.
  const pdf = pdfFromJpeg(
    jpeg,
    { width: canvas.width, height: canvas.height },
    { width: chart.width, height: chart.height },
  );
  save(new Blob([pdf], { type: 'application/pdf' }), `${name}.pdf`);
}
