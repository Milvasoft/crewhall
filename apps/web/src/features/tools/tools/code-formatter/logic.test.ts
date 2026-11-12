// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/code-formatter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { FORMATTER_LANGS, formatCode } from './logic';

describe('code-formatter', () => {
  it('lists the expected languages with parsers', () => {
    expect(Object.keys(FORMATTER_LANGS).sort()).toEqual(
      [
        'css',
        'html',
        'javascript',
        'json',
        'less',
        'markdown',
        'scss',
        'typescript',
        'yaml',
      ].sort(),
    );
    expect(FORMATTER_LANGS.javascript.parser).toBe('babel');
    expect(FORMATTER_LANGS.json.parser).toBe('json');
  });

  it('formats messy JavaScript', async () => {
    const out = await formatCode('const x={a:1,b:2}', 'javascript');
    expect(out).toBe('const x = { a: 1, b: 2 };\n');
  });

  it('formats TypeScript with type annotations', async () => {
    const out = await formatCode('const x:number=1', 'typescript');
    expect(out).toBe('const x: number = 1;\n');
  });

  it('formats JSON', async () => {
    const out = await formatCode('{"a":1,   "b":2}', 'json');
    expect(out).toBe('{ "a": 1, "b": 2 }\n');
  });

  it('formats CSS', async () => {
    const out = await formatCode('.a{color:red;background:blue}', 'css');
    expect(out).toBe('.a {\n  color: red;\n  background: blue;\n}\n');
  });

  it('formats SCSS with nesting', async () => {
    const out = await formatCode('.a{ .b { color: red } }', 'scss');
    expect(out).toBe('.a {\n  .b {\n    color: red;\n  }\n}\n');
  });

  it('formats LESS with variables', async () => {
    const out = await formatCode('@var: red; .a{color:@var}', 'less');
    expect(out).toBe('@var: red;\n.a {\n  color: @var;\n}\n');
  });

  it('formats HTML', async () => {
    const out = await formatCode('<div><p>hi</p></div>', 'html');
    expect(out).toBe('<div><p>hi</p></div>\n');
  });

  it('formats Markdown, collapsing extra whitespace', async () => {
    const out = await formatCode('# hi\n\nsome    text', 'markdown');
    expect(out).toBe('# hi\n\nsome text\n');
  });

  it('formats YAML', async () => {
    const out = await formatCode('a:   1\nb:  2\n', 'yaml');
    expect(out).toBe('a: 1\nb: 2\n');
  });

  it('is idempotent across all languages (formatting twice is a no-op)', async () => {
    const samples: [string, keyof typeof FORMATTER_LANGS][] = [
      ['const x={a:1,b:2}', 'javascript'],
      ['const x:number=1', 'typescript'],
      ['{"a":1,"b":2}', 'json'],
      ['.a{color:red}', 'css'],
      ['.a{ .b { color: red } }', 'scss'],
      ['@var: red; .a{color:@var}', 'less'],
      ['<div><p>hi</p></div>', 'html'],
      ['# hi\n\nsome text', 'markdown'],
      ['a: 1\nb: 2\n', 'yaml'],
    ];
    for (const [code, lang] of samples) {
      const once = await formatCode(code, lang);
      const twice = await formatCode(once, lang);
      expect(twice).toBe(once);
    }
  });

  it('rejects syntactically invalid JavaScript', async () => {
    await expect(formatCode('const x = {', 'javascript')).rejects.toThrow();
  });

  it('rejects syntactically invalid TypeScript', async () => {
    await expect(formatCode('const x: = ', 'typescript')).rejects.toThrow();
  });

  it('rejects syntactically invalid JSON', async () => {
    await expect(formatCode('{a: ', 'json')).rejects.toThrow();
  });

  it('rejects syntactically invalid CSS', async () => {
    await expect(formatCode('.a{ color: ', 'css')).rejects.toThrow();
  });

  it('rejects syntactically invalid YAML', async () => {
    await expect(formatCode('a: : bad: :', 'yaml')).rejects.toThrow();
  });

  it('returns an empty string for empty input', async () => {
    expect(await formatCode('', 'javascript')).toBe('');
  });
});
