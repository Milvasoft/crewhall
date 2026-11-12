// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-xml/logic.ts. See THIRD_PARTY.md.
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// Attributes are represented in JSON with an "@_" prefix (fast-xml-parser
// convention), so the conversion round-trips attributes as well as elements.
const OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
} as const;

export function xmlToJson(xmlText: string, indent = 2): string {
  const parser = new XMLParser({ ...OPTIONS, parseAttributeValue: true });
  const obj = parser.parse(xmlText);
  return JSON.stringify(obj, null, indent);
}

export function jsonToXml(jsonText: string): string {
  const value = JSON.parse(jsonText) as unknown;
  const builder = new XMLBuilder({
    ...OPTIONS,
    format: true,
    indentBy: '  ',
  });
  return builder.build(value).trimEnd();
}
