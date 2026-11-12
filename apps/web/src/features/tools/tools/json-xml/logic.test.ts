// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-xml/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { jsonToXml, xmlToJson } from './logic';

describe('json-xml', () => {
  it('converts XML to JSON with typed values', () => {
    const json = JSON.parse(xmlToJson('<r><a>1</a><b>text</b></r>'));
    expect(json).toEqual({ r: { a: 1, b: 'text' } });
  });

  it('converts JSON to XML', () => {
    const xml = jsonToXml('{"note":{"to":"A","from":"B"}}');
    expect(xml).toContain('<note>');
    expect(xml).toContain('<to>A</to>');
    expect(xml).toContain('<from>B</from>');
  });

  it('round-trips element structure', () => {
    const xml = jsonToXml('{"root":{"item":["x","y"]}}');
    const back = JSON.parse(xmlToJson(xml));
    expect(back.root.item).toEqual(['x', 'y']);
  });

  it('preserves attributes', () => {
    const json = JSON.parse(xmlToJson('<a id="5">hi</a>'));
    expect(json.a['@_id']).toBe(5);
  });

  it('converts a JSON attribute/text object back into an XML attribute', () => {
    const xml = jsonToXml('{"a":{"@_id":"5","#text":"hi"}}');
    expect(xml).toBe('<a id="5">hi</a>');
  });

  it('parses an empty document to an empty object', () => {
    expect(xmlToJson('')).toBe('{}');
  });

  it('throws on invalid JSON input', () => {
    expect(() => jsonToXml('')).toThrow();
    expect(() => jsonToXml('{not valid json')).toThrow();
  });

  it('respects the indent parameter', () => {
    expect(xmlToJson('<a><b>1</b></a>', 4)).toBe('{\n    "a": {\n        "b": 1\n    }\n}');
    expect(xmlToJson('<a><b>1</b></a>', 0)).toBe('{"a":{"b":1}}');
  });

  it('parses malformed XML (unbalanced/mismatched tags) leniently rather than throwing', () => {
    // fast-xml-parser does not validate tag balance; document current behavior
    // so a future parser upgrade that starts throwing is caught as a change.
    expect(() => xmlToJson('<a><b></a>')).not.toThrow();
    expect(() => xmlToJson('<a><b></c></a>')).not.toThrow();
  });
});
