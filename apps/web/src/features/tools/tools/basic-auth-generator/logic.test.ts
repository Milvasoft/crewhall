// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/basic-auth-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { basicAuth } from './logic';

describe('basic-auth-generator', () => {
  it('encodes the canonical RFC example', () => {
    // "Aladdin:open sesame" → QWxhZGRpbjpvcGVuIHNlc2FtZQ==
    const r = basicAuth('Aladdin', 'open sesame');
    expect(r.token).toBe('QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
    expect(r.header).toBe('Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
  });

  it('handles UTF-8 credentials', () => {
    const r = basicAuth('üser', 'pä55');
    // Decodes back to the original "user:pass" bytes.
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(r.token), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe('üser:pä55');
  });

  it('handles empty username and password', () => {
    const r = basicAuth('', '');
    expect(r.token).toBe('Og==');
    expect(r.header).toBe('Authorization: Basic Og==');
  });

  it('builds a curl command containing the raw credentials', () => {
    const r = basicAuth('admin', 's3cret');
    expect(r.curl).toBe("curl -u 'admin:s3cret' https://example.com");
  });

  it('produces a token that decodes back to `username:password`', () => {
    const r = basicAuth('emoji😀user', 'pass:word');
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(r.token), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe('emoji😀user:pass:word');
  });
});
