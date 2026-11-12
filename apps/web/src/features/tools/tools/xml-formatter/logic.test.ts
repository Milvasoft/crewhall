// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/xml-formatter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { formatXml, minifyXml, parseXmlTree } from './logic';

describe('xml-formatter', () => {
  it('pretty-prints XML with indentation', () => {
    const out = formatXml('<root><a>1</a><b>2</b></root>');
    expect(out).toContain('\n');
    expect(out).toContain('<a>1</a>');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('preserves attributes', () => {
    expect(formatXml('<a id="5"><b>x</b></a>')).toContain('id="5"');
  });

  it('minifies XML', () => {
    const out = minifyXml('<root>\n  <a>1</a>\n</root>');
    expect(out).toBe('<root><a>1</a></root>');
  });

  it('throws on non-XML', () => {
    expect(() => formatXml('not xml at all')).toThrow();
  });

  it('parses XML into a tree with attributes and text', () => {
    const tree = parseXmlTree('<note id="1"><to>Ada</to></note>');
    expect(tree).toHaveLength(1);
    const note = tree[0]!;
    expect(note.type).toBe('element');
    if (note.type !== 'element') return;
    expect(note.name).toBe('note');
    expect(note.attributes).toEqual([{ name: 'id', value: '1' }]);
    const to = note.children[0]!;
    expect(to.type).toBe('element');
    if (to.type !== 'element') return;
    expect(to.name).toBe('to');
    expect(to.children[0]).toEqual({ type: 'text', text: 'Ada' });
  });

  it('throws on empty or whitespace-only input', () => {
    expect(() => formatXml('')).toThrow('No XML elements found.');
    expect(() => formatXml('   \n  ')).toThrow('No XML elements found.');
    expect(() => minifyXml('')).toThrow('No XML elements found.');
    expect(() => parseXmlTree('')).toThrow('No XML elements found.');
  });

  it('honors a custom indentBy string', () => {
    const out = formatXml('<root><a>1</a></root>', '\t');
    expect(out).toContain('\n\t<a>1</a>');
  });

  it('is idempotent: formatting already-formatted XML changes nothing', () => {
    const once = formatXml('<root><a>1</a><b>2</b></root>');
    const twice = formatXml(once);
    expect(twice).toBe(once);
  });

  it('round-trips XML entities through format, minify and the tree parser', () => {
    const xml = '<a>1 &amp; 2 &lt;3&gt; "quoted"</a>';
    expect(formatXml(xml)).toContain('1 &amp; 2 &lt;3&gt;');
    expect(minifyXml(xml)).toBe('<a>1 &amp; 2 &lt;3&gt; &quot;quoted&quot;</a>');
    const tree = parseXmlTree(xml);
    const el = tree[0]!;
    if (el.type !== 'element') throw new Error('expected element');
    expect(el.children[0]).toEqual({ type: 'text', text: '1 & 2 <3> "quoted"' });
  });

  it('decodes CDATA sections into plain text', () => {
    const tree = parseXmlTree('<a><![CDATA[hi & bye]]></a>');
    const el = tree[0]!;
    if (el.type !== 'element') throw new Error('expected element');
    expect(el.children[0]).toEqual({ type: 'text', text: 'hi & bye' });
    expect(formatXml('<a><![CDATA[hi & bye]]></a>')).toContain('hi &amp; bye');
  });

  it('handles self-closing/empty elements consistently', () => {
    expect(formatXml('<a/>')).toContain('<a/>');
    expect(minifyXml('<a/>')).toBe('<a></a>');
    const tree = parseXmlTree('<a/>');
    const el = tree[0]!;
    if (el.type !== 'element') throw new Error('expected element');
    expect(el.children).toEqual([]);
  });

  it('handles multiple top-level (root) elements without throwing', () => {
    const out = formatXml('<a>1</a><b>2</b>');
    expect(out).toContain('<a>1</a>');
    expect(out).toContain('<b>2</b>');
    expect(parseXmlTree('<a/><b/>')).toHaveLength(2);
  });

  it('preserves unicode text (accents, CJK, emoji) through format/minify/tree', () => {
    const xml = '<a>héllo 世界 😀</a>';
    expect(formatXml(xml)).toContain('héllo 世界 😀');
    expect(minifyXml(xml)).toBe('<a>héllo 世界 😀</a>');
    const tree = parseXmlTree(xml);
    const el = tree[0]!;
    if (el.type !== 'element') throw new Error('expected element');
    expect(el.children[0]).toEqual({ type: 'text', text: 'héllo 世界 😀' });
  });

  it('preserves and escapes attribute values containing entities', () => {
    const out = formatXml('<a x="1&amp;2"></a>');
    expect(out).toContain('x="1&amp;2"');
    const tree = parseXmlTree('<a x="1&amp;2"></a>');
    const el = tree[0]!;
    if (el.type !== 'element') throw new Error('expected element');
    expect(el.attributes).toEqual([{ name: 'x', value: '1&2' }]);
  });
});
