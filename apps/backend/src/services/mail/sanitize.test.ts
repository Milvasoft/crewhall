import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from './crypto';
import { htmlToText, sanitizeHtml } from './sanitize';

const clean = (html: string, remoteImages = false) => sanitizeHtml(html, { remoteImages });

describe('mail HTML sanitizer', () => {
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x.swf"></object>',
    '<embed src="x">',
    '<form action="https://evil.example"><input name=p><button>go</button></form>',
    '<svg><script>alert(1)</script></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<div style="width: expression(alert(1))">x</div>',
    '<style>@import url(https://evil.example/x.css); p{color:red}</style>',
    '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
  ])('removes the active part of %s', (input) => {
    const { html } = clean(input, true);
    expect(html).not.toMatch(
      /<script|onerror|javascript:|<iframe|<object|<embed|<form|<input|<button|<base|<meta|<link|expression\(|@import|data:text/i,
    );
  });

  it('keeps layout, opens links in a new tab without the referrer', () => {
    const { html } = clean(
      '<table width="100%"><tr><td style="color:#333" align="center"><a href="https://x.example">x</a></td></tr></table>',
    );
    expect(html).toContain('<table width="100%">');
    expect(html).toContain('style="color:#333"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('blocks remote images and CSS backgrounds unless asked, and counts them', () => {
    const input =
      '<img src="https://t.example/p.gif"><p style="background-image:url(\'https://t.example/b.png\')">x</p>' +
      '<style>body{background:url(//t.example/c.png)}</style>';
    const blocked = clean(input);
    expect(blocked.html).not.toContain('t.example');
    expect(blocked.html).toContain('data-blocked="1"');
    expect(blocked.blockedImages).toBe(3);
    const shown = clean(input, true);
    expect(shown.html).toContain('https://t.example/p.gif');
    expect(shown.blockedImages).toBe(0);
  });

  it('embeds cid images and keeps data: images only when they are images', () => {
    const inline = new Map([['logo@x', 'data:image/png;base64,AAAA']]);
    const { html } = sanitizeHtml('<img src="cid:Logo@X"><img src="cid:missing">', {
      remoteImages: false,
      inlineImages: inline,
    });
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('cid:');
  });

  it('derives a plain text alternative', () => {
    expect(htmlToText('<p>Merhaba&nbsp;<b>Deniz</b>,</p><ul><li>bir</li><li>iki</li></ul>')).toBe(
      'Merhaba Deniz,\n• bir\n• iki',
    );
  });
});

describe('mail secrets', () => {
  it('round-trips and refuses a wrong key or damaged value', () => {
    const key = 'test-secret-0123456789abcdef0123456789';
    const sealed = sealSecret(key, 'app-password');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('app-password');
    expect(openSecret(key, sealed)).toBe('app-password');
    expect(openSecret('another-secret-0123456789abcdef012345', sealed)).toBeNull();
    // Flip a byte in the middle of the ciphertext, not its last base64url characters: those
    // carry unused bits, so a swap there can leave the bytes unchanged.
    const [v, iv, tag, body] = sealed.split('.');
    const bytes = Buffer.from(body!, 'base64url');
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = bytes[mid]! ^ 0xff;
    expect(openSecret(key, [v, iv, tag, bytes.toString('base64url')].join('.'))).toBeNull();
    expect(openSecret(key, null)).toBeNull();
  });
});
