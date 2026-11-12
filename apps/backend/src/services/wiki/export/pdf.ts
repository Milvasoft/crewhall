import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pdfmake from 'pdfmake';
import type { PMDoc, PMMark, PMNode } from '../doc';
import type { ExportFile } from './collect';
import { prepareImage, type PreparedImage } from './images';
import { imageWidth, isImageAlign } from '@crewhall/editor';

/**
 * A page as PDF (roadmap 6) with pdfmake (MIT) and its Roboto font (Apache 2.0): text, lists,
 * tables, code and images are laid out in the server process, no headless browser. Emoji are
 * left out (the font has none).
 */

type Content = Record<string, unknown> | string | Content[];

/** A4 width minus margins, in points. */
const PAGE_WIDTH = 595.28 - 2 * 56;
const GREY = '#f4f4f2';
const EMOJI = /\p{Extended_Pictographic}️?|️/gu;

let configured = false;
function setup() {
  if (configured) return;
  const require = createRequire(import.meta.url);
  const fonts = join(dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
  pdfmake.setFonts({
    Roboto: {
      normal: join(fonts, 'Roboto-Regular.ttf'),
      bold: join(fonts, 'Roboto-Medium.ttf'),
      italics: join(fonts, 'Roboto-Italic.ttf'),
      bolditalics: join(fonts, 'Roboto-MediumItalic.ttf'),
    },
  });
  // Nothing outside the fonts is read, nothing is fetched: images come embedded.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path: string) => path.startsWith(fonts));
  configured = true;
}

const clean = (s: string) => s.replace(EMOJI, '');

export class PdfRenderer {
  private readonly images = new Map<string, PreparedImage | null>();

  constructor(private readonly files: Map<string, ExportFile>) {}

  async prepare(doc: PMDoc) {
    const visit = async (n: PMNode) => {
      const id =
        n.type === 'image' ? /^asset:(.+)$/.exec(String(n.attrs?.src ?? ''))?.[1] : undefined;
      if (id && !this.images.has(id)) {
        const file = this.files.get(id);
        // pdfmake sizes in points; 1.33 px per pt keeps images crisp at full width.
        this.images.set(
          id,
          file ? await prepareImage(file, 'pdf', Math.round(PAGE_WIDTH * 1.333)) : null,
        );
      }
      for (const c of n.content ?? []) await visit(c);
    };
    for (const n of doc.content) await visit(n);
  }

  private textOf(text: string, marks: PMMark[] | undefined) {
    const has = (t: string) => marks?.some((m) => m.type === t) ?? false;
    const link = marks?.find((m) => m.type === 'link');
    return {
      text: clean(text),
      ...(has('bold') ? { bold: true } : {}),
      ...(has('italic') ? { italics: true } : {}),
      ...(has('strike') ? { decoration: 'lineThrough' } : {}),
      ...(has('code') ? { background: GREY, fontSize: 9.5 } : {}),
      ...(link
        ? { link: String(link.attrs?.href ?? ''), color: '#9a6700', decoration: 'underline' }
        : {}),
    };
  }

  /** Inline content: runs of text, and images as their own lines. */
  private inline(nodes: PMNode[] | undefined): Content[] {
    const out: Content[] = [];
    let runs: Content[] = [];
    const flush = () => {
      if (runs.length) out.push({ text: runs });
      runs = [];
    };
    for (const n of nodes ?? []) {
      if (n.type === 'hardBreak') runs.push('\n');
      else if (n.type === 'image') {
        const id = /^asset:(.+)$/.exec(String(n.attrs?.src ?? ''))?.[1];
        const img = id ? this.images.get(id) : null;
        if (img) {
          flush();
          const percent = imageWidth(n.attrs?.width);
          const align = isImageAlign(n.attrs?.align) ? n.attrs?.align : undefined;
          const width = percent
            ? (PAGE_WIDTH * percent) / 100
            : Math.min(PAGE_WIDTH, img.width * 0.75);
          out.push({
            ...(align ? { alignment: align } : {}),
            image: `data:image/${img.type === 'jpg' ? 'jpeg' : img.type};base64,${img.data.toString('base64')}`,
            width,
            margin: [0, 4, 0, 4],
          });
        } else {
          const src = String(n.attrs?.src ?? '');
          const label = clean(String(n.attrs?.alt ?? '')) || src;
          if (/^https?:/i.test(src)) runs.push({ text: `[${label}]`, link: src, color: '#9a6700' });
        }
      } else if (n.type === 'htmlInline')
        runs.push({ text: String(n.attrs?.html ?? ''), fontSize: 9.5 });
      else if (n.type === 'mathInline')
        runs.push({ text: String(n.attrs?.latex ?? ''), fontSize: 9.5, background: GREY });
      else if (n.text) runs.push(this.textOf(n.text, n.marks));
    }
    flush();
    return out;
  }

  private para(nodes: PMNode[] | undefined, extra: Record<string, unknown> = {}): Content {
    const parts = this.inline(nodes);
    if (!parts.length) return { text: ' ', ...extra };
    return parts.length === 1 && typeof parts[0] === 'object' && !Array.isArray(parts[0])
      ? { ...(parts[0] as Record<string, unknown>), ...extra }
      : { stack: parts, ...extra };
  }

  blocks(nodes: PMNode[] | undefined): Content[] {
    return (nodes ?? []).flatMap((n) => this.block(n));
  }

  private codeBox(code: string, title?: string): Content[] {
    return [
      ...(title
        ? [{ text: clean(title), bold: true, fontSize: 9, color: '#5b5f63', margin: [0, 4, 0, 2] }]
        : []),
      {
        table: {
          widths: ['*'],
          body: [[{ text: code, fontSize: 9, preserveLeadingSpaces: true }]],
        },
        layout: {
          fillColor: () => GREY,
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 8,
          paddingRight: () => 8,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
        margin: [0, 2, 0, 8],
      },
    ];
  }

  private block(n: PMNode): Content[] {
    const a = n.attrs ?? {};
    switch (n.type) {
      case 'paragraph':
        return [this.para(n.content, { margin: [0, 0, 0, 6] })];
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(a.level ?? 1)));
        return [this.para(n.content, { style: `h${Math.min(level, 4)}` })];
      }
      case 'blockquote':
        return [{ stack: this.blocks(n.content), margin: [14, 0, 0, 6], color: '#555555' }];
      case 'bulletList':
        return [{ ul: (n.content ?? []).map((i) => this.item(i)), margin: [0, 0, 0, 6] }];
      case 'orderedList':
        return [
          {
            ol: (n.content ?? []).map((i) => this.item(i)),
            start: Number(a.start ?? 1),
            margin: [0, 0, 0, 6],
          },
        ];
      case 'taskList':
        return [
          {
            stack: (n.content ?? []).map((i) => ({
              columns: [
                {
                  width: 18,
                  text: i.attrs?.checked ? '[x]' : '[ ]',
                  fontSize: 9,
                  margin: [0, 1, 0, 0],
                },
                { width: '*', stack: this.blocks(i.content) },
              ],
            })),
            margin: [0, 0, 0, 6],
          },
        ];
      case 'codeBlock':
      case 'mermaid':
        return this.codeBox(
          (n.content ?? []).map((c) => c.text ?? '').join(''),
          a.title ? String(a.title) : undefined,
        );
      case 'htmlBlock':
        return this.codeBox(String(a.html ?? ''));
      case 'horizontalRule':
        return [
          {
            canvas: [
              {
                type: 'line',
                x1: 0,
                y1: 0,
                x2: PAGE_WIDTH,
                y2: 0,
                lineWidth: 0.5,
                lineColor: '#cccccc',
              },
            ],
            margin: [0, 6, 0, 10],
          },
        ];
      case 'table':
        return [this.table(n)];
      case 'admonition':
        return [
          {
            table: {
              widths: ['*'],
              body: [
                [
                  {
                    stack: [
                      ...(a.title || a.type
                        ? [
                            {
                              text: clean(String(a.title || a.type)),
                              bold: true,
                              margin: [0, 0, 0, 2],
                            },
                          ]
                        : []),
                      ...this.blocks(n.content),
                    ],
                  },
                ],
              ],
            },
            layout: {
              fillColor: () => GREY,
              hLineWidth: () => 0,
              vLineWidth: (i: number) => (i === 0 ? 3 : 0),
              vLineColor: () => '#FBC419',
              paddingLeft: () => 10,
              paddingRight: () => 10,
              paddingTop: () => 6,
              paddingBottom: () => 6,
            },
            margin: [0, 2, 0, 8],
          },
        ];
      case 'toggle':
        return [
          {
            text: `▸ ${clean(String(a.summary ?? ''))}`,
            bold: true,
            margin: [0, 0, 0, 2],
            ...(a.level ? { style: `h${Number(a.level)}` } : {}),
          },
          { stack: this.blocks(n.content), margin: [12, 0, 0, 4] },
        ];
      // pdfmake cannot draw formulas: the LaTeX stays readable as text.
      case 'mathBlock':
        return this.codeBox(String(a.latex ?? ''));
      case 'columns':
        return [
          {
            columns: (n.content ?? []).map((column) => ({
              width: '*',
              stack: this.blocks(column.content),
            })),
            columnGap: 16,
            margin: [0, 0, 0, 6],
          },
        ];
      case 'tabs':
        return this.blocks(n.content);
      case 'tabItem':
        return [
          { text: clean(String(a.label ?? a.value ?? '')), bold: true, margin: [0, 4, 0, 2] },
          ...this.blocks(n.content),
        ];
      case 'truncate':
        return [];
      default:
        return n.content ? this.blocks(n.content) : [];
    }
  }

  private item(item: PMNode): Content {
    const parts = this.blocks(item.content);
    return parts.length === 1 ? parts[0]! : { stack: parts };
  }

  private table(n: PMNode): Content {
    const rows = n.content ?? [];
    const columns = Math.max(
      1,
      ...rows.map((r) =>
        (r.content ?? []).reduce((s, c) => s + (Number(c.attrs?.colspan ?? 1) || 1), 0),
      ),
    );
    const body = rows.map((row) => {
      const cells: Content[] = [];
      for (const cell of row.content ?? []) {
        const span = Number(cell.attrs?.colspan ?? 1) || 1;
        cells.push({
          stack: this.blocks(cell.content),
          ...(span > 1 ? { colSpan: span } : {}),
          ...(Number(cell.attrs?.rowspan ?? 1) > 1 ? { rowSpan: Number(cell.attrs?.rowspan) } : {}),
          ...(cell.type === 'tableHeader' ? { bold: true, fillColor: GREY } : {}),
          ...(cell.attrs?.align ? { alignment: String(cell.attrs.align) } : {}),
        });
        for (let i = 1; i < span; i++) cells.push({});
      }
      while (cells.length < columns) cells.push({});
      return cells;
    });
    const headerRows = rows[0]?.content?.every((c) => c.type === 'tableHeader') ? 1 : 0;
    return {
      table: { headerRows, widths: Array(columns).fill('*'), body },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
        hLineColor: () => '#dddddd',
        vLineColor: () => '#dddddd',
      },
      margin: [0, 2, 0, 8],
    };
  }
}

export async function renderPdf(
  files: Map<string, ExportFile>,
  page: { title: string; doc: PMDoc },
): Promise<Buffer> {
  setup();
  const r = new PdfRenderer(files);
  await r.prepare(page.doc);
  const definition = {
    pageSize: 'A4',
    pageMargins: [56, 56, 56, 56],
    info: { title: page.title },
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25 },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 12] },
      h1: { fontSize: 18, bold: true, margin: [0, 12, 0, 6] },
      h2: { fontSize: 15, bold: true, margin: [0, 10, 0, 5] },
      h3: { fontSize: 13, bold: true, margin: [0, 8, 0, 4] },
      h4: { fontSize: 11.5, bold: true, margin: [0, 6, 0, 3] },
    },
    content: [{ text: clean(page.title), style: 'title' }, ...r.blocks(page.doc.content)],
  };
  return pdfmake.createPdf(definition).getBuffer();
}
