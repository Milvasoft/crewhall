// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/xml-formatter/logic.ts. See THIRD_PARTY.md.
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// preserveOrder keeps element order & mixed content, so reformatting is lossless.
const PARSE_OPTS = {
  ignoreAttributes: false,
  preserveOrder: true,
  parseTagValue: false,
  trimValues: true,
} as const;

function parse(xml: string) {
  const parser = new XMLParser(PARSE_OPTS);
  const tree = parser.parse(xml);
  if (!Array.isArray(tree) || tree.length === 0) {
    throw new Error('No XML elements found.');
  }
  return tree;
}

export function formatXml(xml: string, indentBy = '  '): string {
  const tree = parse(xml);
  const builder = new XMLBuilder({
    ...PARSE_OPTS,
    format: true,
    indentBy,
    suppressEmptyNode: true,
  });
  return builder
    .build(tree)
    .replace(/\n\s*\n/g, '\n')
    .trimEnd();
}

export function minifyXml(xml: string): string {
  const tree = parse(xml);
  const builder = new XMLBuilder({ ...PARSE_OPTS, format: false });
  return builder.build(tree).replace(/>\s+</g, '><').trim();
}

// --- Tree model -------------------------------------------------------------

export interface XmlAttribute {
  name: string;
  value: string;
}

export type XmlNode =
  | {
      type: 'element';
      name: string;
      attributes: XmlAttribute[];
      children: XmlNode[];
    }
  | { type: 'text'; text: string };

/** Strip fast-xml-parser's attribute prefix (default "@_"). */
function attrName(raw: string): string {
  return raw.replace(/^@_/, '');
}

function walk(items: unknown[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const item of items as Record<string, unknown>[]) {
    const keys = Object.keys(item).filter((k) => k !== ':@');
    const key = keys[0];
    if (key === undefined) continue;

    if (key === '#text') {
      const text = String(item['#text']);
      if (text.trim() !== '') out.push({ type: 'text', text });
      continue;
    }

    const attrsRaw = (item[':@'] as Record<string, unknown> | undefined) ?? {};
    const attributes: XmlAttribute[] = Object.entries(attrsRaw).map(([k, v]) => ({
      name: attrName(k),
      value: String(v),
    }));
    const children = walk((item[key] as unknown[]) ?? []);
    out.push({ type: 'element', name: key, attributes, children });
  }
  return out;
}

/** Parse XML into a nested, render-friendly tree. Throws on invalid XML. */
export function parseXmlTree(xml: string): XmlNode[] {
  return walk(parse(xml));
}
