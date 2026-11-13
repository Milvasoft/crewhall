import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import type { PMDoc, PMMark, PMNode } from '../doc';
import type { ExportFile } from './collect';
import { prepareImage, type PreparedImage } from './images';
import { columnWidth, imageWidth } from '@crewhall/editor';

/** Width of a page's text in Word, in the pixels ImageRun measures in. */
const DOCX_TEXT_WIDTH = 600;

function imageSize(img: { width: number; height: number }, percent: number | null) {
  if (!percent) return { width: img.width, height: img.height };
  const width = Math.round((DOCX_TEXT_WIDTH * percent) / 100);
  return { width, height: Math.round((img.height * width) / img.width) };
}

/** A page as a Word document (roadmap 6) with the `docx` library (MIT); images embedded. */

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];
const MONO = 'Consolas';
const GREY = 'F4F4F2';
/** Usable width of an A4 page with Word's default margins, in pixels at 96 dpi. */
const MAX_IMAGE_PX = 600;

interface Ctx {
  list?: { kind: 'bullet' | 'number'; level: number; instance: number };
  quote?: boolean;
}

export class DocxRenderer {
  private instance = 0;
  private readonly images = new Map<string, PreparedImage | null>();

  constructor(private readonly files: Map<string, ExportFile>) {}

  /** Images are converted once up front (sharp is async; docx building is not). */
  async prepare(doc: PMDoc) {
    const ids = new Set<string>();
    const visit = (n: PMNode) => {
      const id =
        n.type === 'image' ? /^asset:(.+)$/.exec(String(n.attrs?.src ?? ''))?.[1] : undefined;
      if (id) ids.add(id);
      n.content?.forEach(visit);
    };
    doc.content.forEach(visit);
    for (const id of ids) {
      if (this.images.has(id)) continue;
      const file = this.files.get(id);
      this.images.set(id, file ? await prepareImage(file, 'docx', MAX_IMAGE_PX) : null);
    }
  }

  private runs(nodes: PMNode[] | undefined, base: { font?: string } = {}): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    for (const n of nodes ?? []) {
      if (n.type === 'hardBreak') {
        out.push(new TextRun({ text: '', break: 1 }));
      } else if (n.type === 'image') {
        const src = String(n.attrs?.src ?? '');
        const id = /^asset:(.+)$/.exec(src)?.[1];
        const img = id ? this.images.get(id) : null;
        if (img) {
          out.push(
            new ImageRun({
              type: img.type,
              data: img.data,
              transformation: imageSize(img, imageWidth(n.attrs?.width)),
              altText: {
                name: String(n.attrs?.alt ?? ''),
                description: String(n.attrs?.alt ?? ''),
              },
            }),
          );
        } else if (/^https?:/i.test(src)) {
          const label = String(n.attrs?.alt ?? '') || src;
          out.push(this.link(src, [new TextRun({ text: `🖼 ${label}`, style: 'Hyperlink' })]));
        }
      } else if (n.type === 'htmlInline') {
        out.push(new TextRun({ text: String(n.attrs?.html ?? ''), font: MONO }));
      } else if (n.type === 'mathInline') {
        out.push(new TextRun({ text: String(n.attrs?.latex ?? ''), font: MONO }));
      } else if (n.text) {
        out.push(this.textRun(n.text, n.marks, base));
      }
    }
    return out;
  }

  private textRun(text: string, marks: PMMark[] | undefined, base: { font?: string }) {
    const has = (t: string) => marks?.some((m) => m.type === t) ?? false;
    const link = marks?.find((m) => m.type === 'link');
    const run = new TextRun({
      text,
      bold: has('bold'),
      italics: has('italic'),
      strike: has('strike'),
      font: has('code') ? MONO : base.font,
      shading: has('code') ? { type: ShadingType.CLEAR, color: 'auto', fill: GREY } : undefined,
      style: link ? 'Hyperlink' : undefined,
    });
    return link ? this.link(String(link.attrs?.href ?? ''), [run]) : run;
  }

  private link(href: string, children: TextRun[]) {
    return new ExternalHyperlink({ link: href, children });
  }

  private para(children: ParagraphChild[], ctx: Ctx, extra: IParagraphOptions = {}) {
    return new Paragraph({
      children,
      ...(ctx.list
        ? ctx.list.kind === 'bullet'
          ? { bullet: { level: ctx.list.level } }
          : {
              numbering: {
                reference: 'numbers',
                level: ctx.list.level,
                instance: ctx.list.instance,
              },
            }
        : {}),
      ...(ctx.quote
        ? {
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 8 } },
          }
        : {}),
      ...extra,
    });
  }

  blocks(nodes: PMNode[] | undefined, ctx: Ctx = {}): (Paragraph | Table)[] {
    return (nodes ?? []).flatMap((n) => this.block(n, ctx));
  }

  private block(n: PMNode, ctx: Ctx): (Paragraph | Table)[] {
    const a = n.attrs ?? {};
    switch (n.type) {
      case 'paragraph':
        return [this.para(this.runs(n.content), ctx)];
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(a.level ?? 1)));
        return [new Paragraph({ children: this.runs(n.content), heading: HEADINGS[level - 1] })];
      }
      case 'blockquote':
        return this.blocks(n.content, { ...ctx, quote: true });
      case 'bulletList':
      case 'taskList':
      case 'orderedList': {
        const level = ctx.list ? Math.min(ctx.list.level + 1, 8) : 0;
        const kind = n.type === 'orderedList' ? 'number' : 'bullet';
        const instance = kind === 'number' ? ++this.instance : 0;
        return (n.content ?? []).flatMap((item) =>
          this.item(item, { ...ctx, list: { kind, level, instance } }),
        );
      }
      case 'codeBlock':
      case 'mermaid': {
        const code = (n.content ?? []).map((c) => c.text ?? '').join('');
        const title = a.title
          ? [
              new Paragraph({
                children: [new TextRun({ text: String(a.title), bold: true, size: 18 })],
              }),
            ]
          : [];
        return [
          ...title,
          new Paragraph({
            children: code
              .split('\n')
              .map(
                (line, i) => new TextRun({ text: line, font: MONO, size: 19, break: i ? 1 : 0 }),
              ),
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: GREY },
          }),
        ];
      }
      case 'horizontalRule':
        return [
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } },
          }),
        ];
      case 'table':
        return [this.table(n)];
      case 'admonition': {
        // A callout reads as an indented block with its title (or type) in bold.
        const title = String(a.title || a.type || '');
        return [
          ...(title
            ? [this.para([new TextRun({ text: title, bold: true })], { quote: true })]
            : []),
          ...this.blocks(n.content, { ...ctx, quote: true }),
        ];
      }
      case 'toggle':
        return [
          new Paragraph({
            children: [new TextRun({ text: `▸ ${String(a.summary ?? '')}`, bold: true })],
            ...(a.level ? { heading: HEADINGS[Number(a.level) - 1] } : {}),
          }),
          ...this.blocks(n.content, { ...ctx, quote: true }),
        ];
      // Word's own formulas are a different language: the LaTeX stays readable as text.
      case 'mathBlock':
        return [
          new Paragraph({ children: [new TextRun({ text: String(a.latex ?? ''), font: MONO })] }),
        ];
      case 'columns':
        return [this.columns(n, ctx)];
      case 'tabs':
        return this.blocks(n.content, ctx);
      case 'tabItem':
        return [
          new Paragraph({
            children: [new TextRun({ text: String(a.label ?? a.value ?? ''), bold: true })],
          }),
          ...this.blocks(n.content, ctx),
        ];
      case 'htmlBlock':
        return [
          new Paragraph({
            children: String(a.html ?? '')
              .split('\n')
              .map(
                (line, i) => new TextRun({ text: line, font: MONO, size: 19, break: i ? 1 : 0 }),
              ),
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: GREY },
          }),
        ];
      case 'truncate':
        return [];
      default:
        return n.content ? this.blocks(n.content, ctx) : [];
    }
  }

  /** A list item: its first paragraph carries the bullet / number, the rest follows indented. */
  private item(item: PMNode, ctx: Ctx): (Paragraph | Table)[] {
    const [first, ...rest] = item.content ?? [];
    const box = item.type === 'taskItem' ? (item.attrs?.checked ? '☑ ' : '☐ ') : '';
    const lead =
      first && (first.type === 'paragraph' || first.type === 'heading')
        ? [this.para([new TextRun(box), ...this.runs(first.content)], ctx)]
        : [this.para([new TextRun(box)], ctx), ...(first ? this.block(first, ctx) : [])];
    const inner = rest.flatMap((c) =>
      c.type === 'bulletList' || c.type === 'orderedList' || c.type === 'taskList'
        ? this.block(c, ctx)
        : this.block(c, { quote: ctx.quote }),
    );
    return [...lead, ...inner];
  }

  /** Word has no columns inside a page's flow: a table without lines looks the same. */
  private columns(n: PMNode, ctx: Ctx): Table {
    const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const borders = { top: none, bottom: none, left: none, right: none };
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { ...borders, insideHorizontal: none, insideVertical: none },
      rows: [
        new TableRow({
          children: (n.content ?? []).map((column) => {
            const children = this.blocks(column.content, ctx);
            const width = columnWidth(column.attrs?.width);
            return new TableCell({
              borders,
              ...(width ? { width: { size: width, type: WidthType.PERCENTAGE } } : {}),
              children: children.length ? children : [new Paragraph('')],
            });
          }),
        }),
      ],
    });
  }

  private table(n: PMNode) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: (n.content ?? []).map(
        (row) =>
          new TableRow({
            tableHeader: row.content?.every((c) => c.type === 'tableHeader') ?? false,
            children: (row.content ?? []).map((cell) => {
              const blocks = this.blocks(cell.content);
              return new TableCell({
                children: blocks.length ? blocks : [new Paragraph('')],
                columnSpan: Number(cell.attrs?.colspan ?? 1) || 1,
                rowSpan: Number(cell.attrs?.rowspan ?? 1) || 1,
                ...(cell.type === 'tableHeader'
                  ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: GREY } }
                  : {}),
              });
            }),
          }),
      ),
    });
  }
}

export async function renderDocx(
  files: Map<string, ExportFile>,
  page: { title: string; icon: string | null; doc: PMDoc },
): Promise<Buffer> {
  const r = new DocxRenderer(files);
  await r.prepare(page.doc);
  const numberLevels = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3]!,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
  const document = new Document({
    title: page.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'numbers', levels: numberLevels }] },
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun(`${page.icon ? `${page.icon} ` : ''}${page.title}`)],
          }),
          ...r.blocks(page.doc.content),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}
