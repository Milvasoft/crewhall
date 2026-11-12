import { resources, type AppLocale } from '@crewhall/i18n';
import type { BrandingData } from '@crewhall/db';
import { readableTextOn, type OrgRole, type SpaceRole } from '@crewhall/shared';

/**
 * Branded e-mail templates (design doc 19.7-19.9): 600 px body, light background in
 * every theme, org logo on top, graphite footer. The product name appears only in
 * the "Crewhall ile" line, which branding can turn off. All copy is in email.json.
 */

export interface MailBrand {
  /** The org the brand came from; its delivery settings send the mail. */
  orgId?: string | null;
  branding: BrandingData;
  /** Light-theme accent; buttons use it with whichever of black and white reads on it. */
  accent: string;
  hubUrl: string;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

const GRAPHITE = '#141516';

type EmailDict = (typeof resources)['tr']['email'];

const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** `{name}` placeholders (ICU simple arguments). Values are escaped by the caller. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
}

const t = (locale: AppLocale) => resources[locale].email as EmailDict;

function formatDate(date: Date, locale: AppLocale, withTime: boolean) {
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', {
    dateStyle: 'long',
    ...(withTime ? { timeStyle: 'short' } : {}),
  }).format(date);
}

function formatTime(date: Date, locale: AppLocale) {
  return new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', {
    timeStyle: 'short',
  }).format(date);
}

export interface Block {
  html: string;
  text: string;
}

export const para = (s: string, muted = false): Block => ({
  html: `<p style="margin:0 0 16px;font-size:${muted ? 13 : 15}px;line-height:1.55;color:${muted ? '#5b5f63' : GRAPHITE}">${esc(s)}</p>`,
  text: s,
});

export const heading = (s: string): Block => ({
  html: `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:800;color:${GRAPHITE}">${esc(s)}</h1>`,
  text: s,
});

export const facts = (rows: [string, string][]): Block => ({
  html:
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #e6e6e3;border-radius:10px;border-collapse:separate">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:10px 14px;font-size:13px;color:#5b5f63;width:38%">${esc(k)}</td><td style="padding:10px 14px;font-size:14px;color:${GRAPHITE};font-weight:600">${esc(v)}</td></tr>`,
      )
      .join('') +
    `</table>`,
  text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
});

/**
 * The text colour comes from the accent. Mail clients in dark mode recolour what they can:
 * bgcolor and the gradient keep the background, -webkit-text-fill-color and the inner span keep
 * the text (Gmail, Apple Mail); layout()'s styles cover Outlook.
 */
export const button = (label: string, url: string, accent: string): Block => {
  const bg = esc(accent);
  const ink = readableTextOn(accent);
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td class="ch-btn" bgcolor="${bg}" style="border-radius:10px;background-color:${bg};background-image:linear-gradient(${bg},${bg})"><a class="ch-btn-a" href="${esc(url)}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:800;color:${ink};-webkit-text-fill-color:${ink};text-decoration:none;border-radius:10px"><span style="color:${ink};-webkit-text-fill-color:${ink}">${esc(label)}</span></a></td></tr></table>`,
    text: `${label}: ${url}`,
  };
};

export const fallbackLink = (locale: AppLocale, url: string): Block => ({
  html: `<p style="margin:0 0 6px;font-size:12px;color:#5b5f63">${esc(t(locale).layout.buttonFallback)}</p><p style="margin:0 0 20px;font-size:12px;word-break:break-all"><a href="${esc(url)}" style="color:#5b5f63">${esc(url)}</a></p>`,
  text: '',
});

/** The mail is light in every client that allows it; where one recolours anyway, the button holds. */
function darkModeStyles(accent: string) {
  const bg = esc(accent);
  const ink = readableTextOn(accent);
  const text = `color:${ink}!important;-webkit-text-fill-color:${ink}!important`;
  const fill = `background-color:${bg}!important`;
  return (
    ':root{color-scheme:light only;supported-color-schemes:light only}' +
    `@media (prefers-color-scheme:dark){.ch-btn{${fill}}.ch-btn-a,.ch-btn-a span{${text}}}` +
    `[data-ogsb] .ch-btn{${fill}}[data-ogsc] .ch-btn-a,[data-ogsc] .ch-btn-a span{${text}}`
  );
}

export function layout(
  brand: MailBrand,
  locale: AppLocale,
  blocks: Block[],
  footerLines: string[],
): { html: string; text: string } {
  const { branding } = brand;
  const logo = branding.logoLightUrl
    ? `<img src="${esc(branding.logoLightUrl)}" alt="${esc(branding.orgName)}" height="32" style="display:block;height:32px;border:0">`
    : `<span style="font-size:20px;font-weight:800;color:${GRAPHITE}">${esc(branding.orgName)}</span>`;
  const host = new URL(brand.hubUrl).host;
  const powered = branding.showPoweredBy
    ? `<p style="margin:0 0 10px;font-size:12px;font-weight:700;color:#FBC419">${esc(t(locale).layout.poweredBy)}</p>`
    : '';
  const footer = footerLines
    .map(
      (l) => `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#b9bcbf">${esc(l)}</p>`,
    )
    .join('');
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><style>${darkModeStyles(brand.accent)}</style></head>
<body style="margin:0;padding:0;background:#f7f7f6;font-family:Nunito,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f6"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e6e3">
<tr><td style="padding:28px 36px 8px">${logo}</td></tr>
<tr><td style="padding:16px 36px 12px">${blocks.map((b) => b.html).join('')}</td></tr>
<tr><td style="padding:22px 36px;background:${GRAPHITE}">${powered}${footer}<p style="margin:0;font-size:12px;color:#b9bcbf">${esc(branding.orgName)} · ${esc(host)}</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    ...blocks.map((b) => b.text).filter(Boolean),
    '',
    '—',
    ...(branding.showPoweredBy ? [t(locale).layout.poweredBy] : []),
    ...footerLines,
    `${branding.orgName} · ${host}`,
  ].join('\n\n');
  return { html, text };
}

export interface InviteMailInput {
  locale: AppLocale;
  to: string;
  inviterName: string;
  inviterEmail: string;
  role: OrgRole;
  spaces: { name: string; role: SpaceRole }[];
  url: string;
  expiresAt: Date;
  twoFactorRequired: boolean;
}

export function inviteMail(brand: MailBrand, input: InviteMailInput): RenderedMail {
  const { locale } = input;
  const d = t(locale).invite;
  const roles = resources[locale].common.roles;
  const vars = { inviterName: input.inviterName, orgName: brand.branding.orgName };
  const rows: [string, string][] = [[d.role, roles.org[input.role]]];
  if (input.spaces.length) {
    rows.push([d.spaces, input.spaces.map((s) => `${s.name} · ${roles.space[s.role]}`).join(', ')]);
  }
  rows.push([d.invitedBy, `${input.inviterName} · ${input.inviterEmail}`]);
  const blocks = [
    heading(fill(d.title, vars)),
    para(d.greeting),
    para(fill(d.intro, vars)),
    facts(rows),
    button(d.cta, input.url, brand.accent),
    para(
      [
        fill(d.expires, { date: formatDate(input.expiresAt, locale, false) }),
        input.twoFactorRequired ? d.twoFactorNote : '',
      ]
        .filter(Boolean)
        .join(' '),
      true,
    ),
    fallbackLink(locale, input.url),
    para(d.ignore, true),
  ];
  const footer = [
    fill(t(locale).layout.sentFor, { orgName: brand.branding.orgName, email: input.to }),
  ];
  return { subject: fill(d.subject, vars), ...layout(brand, locale, blocks, footer) };
}

export interface ResetMailInput {
  locale: AppLocale;
  name: string;
  url: string;
  expiresAt: Date;
  requestedAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export function resetMail(brand: MailBrand, input: ResetMailInput): RenderedMail {
  const { locale } = input;
  const d = t(locale).reset;
  const orgName = brand.branding.orgName;
  const rows: [string, string][] = [[d.requestedAt, formatDate(input.requestedAt, locale, true)]];
  if (input.userAgent) rows.push([d.browser, input.userAgent.slice(0, 120)]);
  if (input.ip) rows.push([d.ip, input.ip]);
  const blocks = [
    heading(d.title),
    para(fill(d.intro, { name: input.name })),
    button(d.cta, input.url, brand.accent),
    para(fill(d.expires, { time: formatTime(input.expiresAt, locale) }), true),
    facts(rows),
    para(d.notMe, true),
    para(fill(d.sessionsNote, { orgName }), true),
    fallbackLink(locale, input.url),
  ];
  return {
    subject: fill(d.subject, { orgName }),
    ...layout(brand, locale, blocks, [t(locale).layout.securityFooter]),
  };
}

export interface VerifyMailInput {
  locale: AppLocale;
  name: string;
  to: string;
  url: string;
}

export function verifyMail(brand: MailBrand, input: VerifyMailInput): RenderedMail {
  const { locale } = input;
  const d = t(locale).verify;
  const orgName = brand.branding.orgName;
  const blocks = [
    heading(d.title),
    para(fill(d.intro, { name: input.name, orgName })),
    button(d.cta, input.url, brand.accent),
    para(d.expires, true),
    fallbackLink(locale, input.url),
    para(d.ignore, true),
  ];
  return {
    subject: fill(d.subject, { orgName }),
    ...layout(brand, locale, blocks, [
      fill(t(locale).layout.sentFor, { orgName, email: input.to }),
    ]),
  };
}

export function smtpTestMail(brand: MailBrand, locale: AppLocale, to: string): RenderedMail {
  const d = t(locale).smtpTest;
  const blocks = [heading(d.title), para(d.intro)];
  return {
    subject: fill(d.subject, { appName: brand.branding.appName }),
    ...layout(brand, locale, blocks, [
      fill(t(locale).layout.sentFor, { orgName: brand.branding.orgName, email: to }),
    ]),
  };
}

/** "Test gönder" on Yönetim › Bildirim gönderimi. */
export function deliveryTestMail(brand: MailBrand, locale: AppLocale, to: string): RenderedMail {
  const d = t(locale).deliveryTest;
  return {
    subject: fill(d.subject, { appName: brand.branding.appName }),
    ...layout(
      brand,
      locale,
      [heading(d.title), para(d.intro)],
      [fill(t(locale).layout.sentFor, { orgName: brand.branding.orgName, email: to })],
    ),
  };
}

export interface LockMailInput {
  locale: AppLocale;
  name: string;
  to: string;
  failures: number;
  lockedUntil: Date;
  lastFailedAt: Date;
  ip: string | null;
  /** Forgot-password page: resetting the password lifts the lock. */
  unlockUrl: string;
}

/** Sent to the person when their account locks (design 1.16, "E-postayla kilidi aç"). */
export function lockMail(brand: MailBrand, input: LockMailInput): RenderedMail {
  const { locale } = input;
  const d = t(locale).lock;
  const orgName = brand.branding.orgName;
  const rows: [string, string][] = [[d.lastAttempt, formatDate(input.lastFailedAt, locale, true)]];
  if (input.ip) rows.push([d.ip, input.ip]);
  const blocks = [
    heading(d.title),
    para(fill(d.intro, { name: input.name, count: String(input.failures) })),
    para(fill(d.until, { time: formatTime(input.lockedUntil, locale) })),
    facts(rows),
    button(d.cta, input.unlockUrl, brand.accent),
    para(d.ctaNote, true),
    para(d.notMe, true),
    fallbackLink(locale, input.unlockUrl),
  ];
  return {
    subject: fill(d.subject, { orgName }),
    ...layout(brand, locale, blocks, [t(locale).layout.securityFooter]),
  };
}

export interface LockAdminMailInput extends Omit<LockMailInput, 'unlockUrl'> {
  /** The locked person (the mail itself goes to an owner or admin). */
  email: string;
  memberUrl: string;
}

/** Sent to org owners and admins when a member locks (design 1.16). */
export function lockAdminMail(brand: MailBrand, input: LockAdminMailInput): RenderedMail {
  const { locale } = input;
  const d = t(locale).lockAdmin;
  const rows: [string, string][] = [[d.lastAttempt, formatDate(input.lastFailedAt, locale, true)]];
  if (input.ip) rows.push([d.ip, input.ip]);
  const blocks = [
    heading(d.title),
    para(fill(d.intro, { name: input.name, email: input.email, count: String(input.failures) })),
    para(fill(d.until, { time: formatTime(input.lockedUntil, locale) })),
    facts(rows),
    button(d.cta, input.memberUrl, brand.accent),
    para(d.note, true),
  ];
  return {
    subject: fill(d.subject, { email: input.email }),
    ...layout(brand, locale, blocks, [t(locale).layout.securityFooter]),
  };
}

/** Building blocks for module mail templates (services/<module>/mail.ts). */
export const mailParts = { layout, heading, para, facts, button, fallbackLink, formatDate, esc };
