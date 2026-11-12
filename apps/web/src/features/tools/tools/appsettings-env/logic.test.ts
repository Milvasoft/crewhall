// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/appsettings-env/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { envToJson, flatten, jsonToEnv, render } from './logic';

const APPSETTINGS = JSON.stringify({
  ConnectionStrings: { Default: 'Server=localhost;Database=test' },
  Jwt: { Issuer: 'example', ExpirationMinutes: 60 },
  Logging: { Enabled: true },
  Cors: { Origins: ['https://a.com', 'https://b.com'] },
});

describe('jsonToEnv', () => {
  it('produces .NET colon format', () => {
    const out = jsonToEnv(APPSETTINGS, 'colon');
    expect(out).toContain('ConnectionStrings:Default=Server=localhost;Database=test');
    expect(out).toContain('Jwt:ExpirationMinutes=60');
  });

  it('produces double-underscore format', () => {
    const out = jsonToEnv(APPSETTINGS, 'double-underscore');
    expect(out).toContain('Jwt__Issuer=example');
    expect(out).toContain('Logging__Enabled=true');
  });

  it('flattens arrays by index', () => {
    const out = jsonToEnv(APPSETTINGS, 'double-underscore');
    expect(out).toContain('Cors__Origins__0=https://a.com');
    expect(out).toContain('Cors__Origins__1=https://b.com');
  });

  it('emits docker-compose and k8s shapes', () => {
    expect(jsonToEnv(APPSETTINGS, 'docker-compose')).toContain('environment:');
    expect(jsonToEnv(APPSETTINGS, 'k8s-configmap')).toContain('kind: ConfigMap');
  });

  it('throws on malformed JSON', () => {
    expect(() => jsonToEnv('{not json', 'colon')).toThrow();
  });

  it('produces an empty string for an empty object', () => {
    expect(jsonToEnv('{}', 'colon')).toBe('');
  });
});

describe('envToJson', () => {
  it('rebuilds nested objects from double underscore', () => {
    const json = envToJson('Jwt__Issuer=example\nJwt__ExpirationMinutes=60');
    expect(JSON.parse(json)).toEqual({
      Jwt: { Issuer: 'example', ExpirationMinutes: 60 },
    });
  });

  it('rebuilds nested objects from colon', () => {
    const json = envToJson('ConnectionStrings:Default=abc');
    expect(JSON.parse(json)).toEqual({ ConnectionStrings: { Default: 'abc' } });
  });

  it('coerces booleans, numbers and null', () => {
    const json = envToJson('A=true\nB=42\nC=null\nD=hello');
    expect(JSON.parse(json)).toEqual({ A: true, B: 42, C: null, D: 'hello' });
  });

  it('rebuilds arrays from numeric segments', () => {
    const json = envToJson('Cors__Origins__0=a\nCors__Origins__1=b');
    expect(JSON.parse(json)).toEqual({ Cors: { Origins: ['a', 'b'] } });
  });

  it('round-trips appsettings', () => {
    const env = jsonToEnv(APPSETTINGS, 'double-underscore');
    const back = JSON.parse(envToJson(env));
    expect(back).toEqual(JSON.parse(APPSETTINGS));
  });

  it('ignores comments and export prefixes', () => {
    const json = envToJson('# comment\nexport Jwt__Issuer=x');
    expect(JSON.parse(json)).toEqual({ Jwt: { Issuer: 'x' } });
  });

  it("ignores blank lines and lines without an '='", () => {
    const json = envToJson('\n   \nnotAKeyValue\nA=1');
    expect(JSON.parse(json)).toEqual({ A: 1 });
  });

  it('coerces an out-of-range integer and a leading decimal point as expected', () => {
    // 20-digit integer exceeds Number.isSafeInteger, so it's kept as a raw string.
    const json = envToJson('Big=99999999999999999999\nFrac=.5');
    expect(JSON.parse(json)).toEqual({ Big: '99999999999999999999', Frac: 0.5 });
  });

  it('prefers double-underscore over colon when a key contains both', () => {
    const json = envToJson('A__B:C=x');
    expect(JSON.parse(json)).toEqual({ A: { 'B:C': 'x' } });
  });

  it('round-trips through bash and powershell formats for values with spaces', () => {
    const src = JSON.stringify({ Message: 'a value with spaces' });
    for (const format of ['bash', 'powershell'] as const) {
      const rendered = jsonToEnv(src, format);
      const back = JSON.parse(envToJson(rendered));
      expect(back).toEqual(JSON.parse(src));
    }
  });
});

describe('flatten', () => {
  it('produces no entries for empty objects and arrays, even nested', () => {
    expect(flatten({})).toEqual([]);
    expect(flatten([])).toEqual([]);
    expect(flatten({ a: {}, b: [] })).toEqual([]);
  });

  it('wraps a top-level primitive as a single entry with an empty path', () => {
    expect(flatten(5)).toEqual([{ path: [], value: 5 }]);
    expect(flatten(null)).toEqual([{ path: [], value: null }]);
  });
});

describe('render', () => {
  const entry = (value: string | number | boolean | null) => [{ path: ['A'], value }];

  it('quotes bash values that need it and escapes embedded single quotes', () => {
    expect(render(entry('plain'), 'bash')).toBe('export A=plain');
    expect(render(entry("it's a test"), 'bash')).toBe("export A='it'\\''s a test'");
    expect(render(entry(''), 'bash')).toBe("export A=''");
  });

  it('escapes embedded single quotes for powershell', () => {
    expect(render(entry("it's"), 'powershell')).toBe("$env:A = 'it''s'");
  });

  it('quotes dotenv values containing whitespace or special characters', () => {
    expect(render(entry('plain'), 'dotenv')).toBe('A=plain');
    expect(render(entry('has "quotes"'), 'dotenv')).toBe('A="has \\"quotes\\""');
  });

  it('escapes quotes in k8s-configmap values', () => {
    expect(render(entry('a "b"'), 'k8s-configmap')).toContain('A: "a \\"b\\""');
  });

  it('renders null as an empty value', () => {
    expect(render(entry(null), 'colon')).toBe('A=');
  });
});
