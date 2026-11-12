import { describe, expect, it } from 'vitest';
import enExtension from '@crewhall/i18n/locales/en/web/extension.json';
import trExtension from '@crewhall/i18n/locales/tr/web/extension.json';
import { normalizeOrigin, pkcePair } from '../src/shared/api';
import { findDate, toLocalInput } from '../src/shared/dates';
import { htmlToMarkdown, sourceLine } from '../src/shared/markdown';
import { isSafeForFilling, matchesAny, uriMatches } from '../src/shared/match';
import { fileNameFor } from '../src/shared/upload';
import { buildManifest } from '../src/manifest';

describe('which logins belong to a page', () => {
  it.each([
    ['https://example.com', 'https://example.com/login', true],
    ['example.com', 'https://www.example.com/', true],
    ['https://example.com', 'https://accounts.example.com/', false],
    ['https://www.example.com', 'https://evil.example.com/', false],
    ['https://accounts.example.com', 'https://shop.example.com/', false],
    ['https://accounts.example.com', 'https://example.com/', false],
    ['https://example.com', 'https://example.com.evil.test/', false],
    ['https://example.com', 'https://notexample.com/', false],
    ['https://example.com', 'http://example.com/', false],
    ['http://example.com', 'https://example.com/', true],
    ['https://example.com:8443', 'https://example.com/', false],
    ['https://example.com:8443', 'https://example.com:8443/x', true],
    ['https://example.com', 'https://example.com:8443/', false],
    ['https://10.0.0.1', 'https://a.10.0.0.1/', false],
    ['https://com', 'https://example.com/', false],
    ['javascript:alert(1)', 'https://example.com/', false],
    ['https://example.com', 'file:///etc/passwd', false],
  ])('%s on %s: %s', (item, page, expected) => {
    expect(uriMatches(item, page)).toBe(expected);
  });

  it('looks at every address of a login', () => {
    expect(matchesAny(['https://a.test', 'https://b.test'], 'https://b.test/x')).toBe(true);
    expect(matchesAny([], 'https://b.test/x')).toBe(false);
  });

  it('fills on https and on this machine only', () => {
    expect(isSafeForFilling('https://example.com')).toBe(true);
    expect(isSafeForFilling('http://localhost:3000')).toBe(true);
    expect(isSafeForFilling('http://example.com')).toBe(false);
    expect(isSafeForFilling('chrome://settings')).toBe(false);
  });
});

describe('addresses and sign-in', () => {
  it('normalizes what people type', () => {
    expect(normalizeOrigin(' Hub.Example.com/login ')).toBe('https://hub.example.com');
    expect(normalizeOrigin('http://localhost:4110/x')).toBe('http://localhost:4110');
    expect(normalizeOrigin('https://user:pw@example.com')).toBeNull();
    expect(normalizeOrigin('ftp://example.com')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });

  it('makes a challenge the server accepts', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).not.toBe(challenge);
  });
});

describe('page HTML to Markdown', () => {
  const base = 'https://example.com/dir/page';

  it('keeps structure and resolves addresses', () => {
    const md = htmlToMarkdown(
      '<h2>Başlık</h2><p>Bir <strong>kalın</strong> ve <a href="../a">bağ</a>.</p><ul><li>bir</li><li>iki</li></ul><img src="/i.png" alt="res">',
      base,
    );
    expect(md).toContain('## Başlık');
    expect(md).toContain('Bir **kalın** ve [bağ](https://example.com/a).');
    expect(md).toContain('- bir\n- iki');
    expect(md).toContain('![res](https://example.com/i.png)');
  });

  it('drops scripts, forms and dangerous links', () => {
    const md = htmlToMarkdown(
      '<script>alert(1)</script><style>a{}</style><form><input value="gizli"></form><a href="javascript:alert(1)">tıkla</a><img src="data:image/png;base64,AA" onerror="x()">',
      base,
    );
    expect(md).toBe('tıkla');
  });

  it('keeps code as written and escapes Markdown in text', () => {
    expect(htmlToMarkdown('<pre><code>a *b*\nc</code></pre>', base)).toBe('```\na *b*\nc\n```');
    expect(htmlToMarkdown('<p>a*b_c</p>', base)).toBe('a\\*b\\_c');
    expect(htmlToMarkdown('<p>::embed{x} <b>y</b></p>', base)).toBe('\\::embed{x} **y**');
    expect(htmlToMarkdown('<p>a <img> <c></p>', base)).toBe('a');
  });

  it('cannot be broken out of by link addresses or code', () => {
    expect(htmlToMarkdown('<a href="https://a.test/)[x](mention:1)">t</a>', base)).toBe(
      '[t](https://a.test/%29[x]%28mention:1%29)',
    );
    expect(htmlToMarkdown('<pre>a\n```\nb</pre>', base)).toBe('````\na\n```\nb\n````');
    expect(htmlToMarkdown('<p><code>a`b</code></p>', base)).toBe('``a`b``');
  });

  it('names the source, only for real addresses', () => {
    expect(sourceLine('Yazı', 'https://example.com/', 'Kaynak')).toBe(
      '> Kaynak: [Yazı](https://example.com/)',
    );
    expect(sourceLine('Yazı', 'javascript:alert(1)', 'Kaynak')).toBe('');
  });
});

describe('dates in selected text', () => {
  const now = new Date(2026, 10, 9, 10, 0);

  it('reads Turkish and English forms', () => {
    expect(toLocalInput(findDate('Toplantı 12 Mart 2027 14:30 da', now)!.date)).toBe('2027-03-12T14:30');
    expect(findDate('12.03.2027 günü', now)).toMatchObject({ hasTime: false });
    expect(toLocalInput(findDate('2027-01-05 09:15', now)!.date)).toBe('2027-01-05T09:15');
    expect(toLocalInput(findDate('June 3, 2027 at 16:00', now)!.date)).toBe('2027-06-03T16:00');
    expect(toLocalInput(findDate('3 Ağustos', now)!.date).startsWith('2027-08-03')).toBe(true);
  });

  it('takes the next occurrence when no year is written', () => {
    expect(findDate('20 Aralık', now)!.date.getFullYear()).toBe(2026);
    expect(findDate('1 Ocak', now)!.date.getFullYear()).toBe(2027);
  });

  it('finds nothing where there is no date', () => {
    expect(findDate('sürüm 3.12 yayında', now)).toBeNull();
    expect(findDate('31.02.2027', now)).toBeNull();
  });
});

describe('file names', () => {
  it('come from the address', () => {
    expect(fileNameFor('https://x.test/a/rapor%20son.pdf?v=1', 'application/pdf', 'f')).toBe('rapor son.pdf');
    expect(fileNameFor('https://x.test/resim', 'image/png', 'f')).toBe('resim.png');
  });

  it('fall back and stay safe', () => {
    expect(fileNameFor('data:image/png;base64,AA', 'image/png', 'Başlık')).toBe('Başlık.png');
    expect(fileNameFor('https://x.test/a%2Fb%3A.txt', 'text/plain', 'f')).toBe('a-b-.txt');
    expect(fileNameFor('https://x.test/', 'text/html', 'sayfa')).toBe('sayfa');
  });
});

function keysOf(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'object' && v ? keysOf(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('texts', () => {
  it('have the same keys in both languages', () => {
    expect(keysOf(enExtension).sort()).toEqual(keysOf(trExtension).sort());
  });
});

describe('manifest', () => {
  const m = buildManifest('1.2.3');

  it('asks for no site at install', () => {
    expect(m.version).toBe('1.2.3');
    expect(JSON.stringify(m.permissions)).not.toContain('://');
    expect(m).not.toHaveProperty('host_permissions');
    expect(m).not.toHaveProperty('content_scripts');
    expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  it('allows WebAssembly but no remote or inline code', () => {
    expect(m.content_security_policy.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    );
  });

  it('has the listed extension id', async () => {
    const { BROWSER_EXTENSION_IDS } = await import('@crewhall/shared');
    const der = Uint8Array.from(atob(m.key), (c) => c.charCodeAt(0));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
    const id = [...hash.slice(0, 16)]
      .flatMap((b) => [b >> 4, b & 15])
      .map((n) => String.fromCharCode(97 + n))
      .join('');
    expect(BROWSER_EXTENSION_IDS).toContain(id);
  });
});
