import { readableTextOn } from '@crewhall/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps';
import { AppError, errorBody } from '../src/http/errors';
import { Router } from '../src/http/route';
import type { AppEnv } from '../src/http/types';
import { inviteMail, fill } from '../src/mail/templates';
import { PRODUCT_BRANDING } from '../src/services/brand';
import { cleanTitle } from '../src/services/quick/links';
import { slugify } from '../src/services/spaces';
import { loadEnv } from '../src/env';

describe('slugify', () => {
  it('maps Turkish letters and punctuation', () => {
    expect(slugify('Altyapı')).toBe('altyapi');
    expect(slugify('İnsan Kaynakları & Ödeme')).toBe('insan-kaynaklari-odeme');
    expect(slugify('ÇĞŞÜ')).toBe('cgsu');
    expect(slugify('!')).toMatch(/^space/);
  });
});

describe('mail templates', () => {
  const brand = {
    branding: { ...PRODUCT_BRANDING, orgName: 'A&B <Ltd>' },
    accent: '#FBC419',
    hubUrl: 'https://hub.example.com',
  };

  it('escapes org data in HTML and keeps the product name to the powered-by line', () => {
    const mail = inviteMail(brand, {
      locale: 'en',
      to: 'x@example.com',
      inviterName: '<script>',
      inviterEmail: 'i@example.com',
      role: 'member',
      spaces: [{ name: 'Ops', role: 'viewer' }],
      url: 'https://hub.example.com/davet/abc',
      expiresAt: new Date('2026-10-26T10:00:00Z'),
      twoFactorRequired: true,
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('A&amp;B &lt;Ltd&gt;');
    expect(mail.html).toContain('with Crewhall');
    expect(mail.text).toContain('https://hub.example.com/davet/abc');
    expect(mail.subject).toBe('<script> invited you to A&B <Ltd>');
  });

  it('makes the button readable on any accent, also in a mail client in dark mode', () => {
    const mailWith = (accent: string) =>
      inviteMail({ ...brand, accent }, {
        locale: 'tr',
        inviterName: 'Ali',
        role: 'member',
        url: 'https://hub.example.com/invite/x',
        expiresAt: new Date('2026-12-01T10:00:00Z'),
        message: null,
        spaces: [],
      } as unknown as Parameters<typeof inviteMail>[1]).html;
    const anchor = (html: string) => /<a class="ch-btn-a"[^>]*style="([^"]*)"/.exec(html)![1]!;
    // The brand's yellow keeps black text.
    expect(anchor(mailWith('#FBC419'))).toContain('color:#000000');
    expect(anchor(mailWith('#FBC419'))).toContain('-webkit-text-fill-color:#000000');
    // An org's dark accent gets white: this was black on navy.
    const navy = mailWith('#12305A');
    expect(anchor(navy)).toContain('color:#FFFFFF');
    expect(navy).toContain('bgcolor="#12305A"');
    expect(navy).toContain('background-image:linear-gradient(#12305A,#12305A)');
    // Clients in dark mode: light only where allowed, and the button holds elsewhere.
    expect(navy).toContain('content="light only"');
    expect(navy).toContain('supported-color-schemes');
    expect(navy).toMatch(
      /@media \(prefers-color-scheme:dark\)\{\.ch-btn\{background-color:#12305A!important/,
    );
    expect(navy).toContain('[data-ogsc] .ch-btn-a');
    expect(navy).toContain('color:#FFFFFF!important');
  });

  it('picks black or white by contrast, always readable', () => {
    const ratio = (a: string, b: string) => {
      const l = (hex: string) => {
        const v = [1, 3, 5].map((i) => {
          const c = parseInt(hex.slice(i, i + 2), 16) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
      };
      const [x, y] = [l(a), l(b)].sort((p, q) => q - p) as [number, number];
      return (x + 0.05) / (y + 0.05);
    };
    expect(readableTextOn('#FBC419')).toBe('#000000');
    expect(readableTextOn('#F38424')).toBe('#000000');
    expect(readableTextOn('#141516')).toBe('#FFFFFF');
    expect(readableTextOn('#12305a')).toBe('#FFFFFF');
    expect(readableTextOn('#fff')).toBe('#000000');
    expect(readableTextOn('not-a-colour')).toBe('#000000');
    for (const bg of ['#777777', '#0000FF', '#FF0000', '#00AA00', '#808000', '#FBC419']) {
      expect(ratio(bg, readableTextOn(bg))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('hides the powered-by line when branding turns it off', () => {
    const off = { ...brand, branding: { ...brand.branding, showPoweredBy: false } };
    const mail = inviteMail(off, {
      locale: 'tr',
      to: 'x@example.com',
      inviterName: 'Elif',
      inviterEmail: 'e@example.com',
      role: 'guest',
      spaces: [],
      url: 'https://hub.example.com/davet/abc',
      expiresAt: new Date(),
      twoFactorRequired: false,
    });
    expect(mail.html).not.toContain('Crewhall ile');
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(fill('{a} and {b}', { a: '1' })).toBe('1 and {b}');
  });
});

describe('env', () => {
  it('requires a database url and a long auth secret', () => {
    expect(() => loadEnv({ AUTH_SECRET: 'short' })).toThrow(/DATABASE_URL[\s\S]*AUTH_SECRET/);
    const env = loadEnv({
      DATABASE_URL: 'postgres://x',
      AUTH_SECRET: 'x'.repeat(32),
      WEB_ORIGINS: 'http://a.test, http://b.test',
      MIGRATE_ON_START: 'true',
      SMTP_URL: '',
    });
    expect(env.WEB_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.MIGRATE_ON_START).toBe(true);
    expect(env.SMTP_URL).toBeUndefined();
  });
});

describe('router', () => {
  it('answers 501 not_implemented for contract endpoints without a handler', async () => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(errorBody(err, 'en'), err.status as 501)
        : c.json({ code: 'internal' }, 500),
    );
    const router = new Router(app, {} as Deps);
    const stubbed = router.stubMissing();
    expect(stubbed).toContain('getQuota');
    const res = await app.request('/api/v1/org/quota');
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      code: 'not_implemented',
      details: { endpoint: 'getQuota' },
    });
  });
});

describe('cleanTitle', () => {
  it('drops repeated parts of site titles', () => {
    expect(
      cleanTitle('GitHub · Change is constant. GitHub keeps you ahead. · GitHub · GitHub'),
    ).toBe('GitHub · Change is constant. GitHub keeps you ahead.');
    expect(cleanTitle('Seq | Seq | Logs')).toBe('Seq | Logs');
    expect(cleanTitle('  Docs   ')).toBe('Docs');
    expect(cleanTitle('Milvaion - Job Scheduler')).toBe('Milvaion - Job Scheduler');
    expect(cleanTitle('')).toBeNull();
  });
});
