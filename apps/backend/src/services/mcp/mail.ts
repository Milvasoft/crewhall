import { resources, type AppLocale } from '@crewhall/i18n';
import type { McpScope } from '@crewhall/shared';
import { fill, mailParts, type MailBrand, type RenderedMail } from '../../mail/templates';

const { layout, heading, para, facts, button, fallbackLink, formatDate } = mailParts;
const t = (locale: AppLocale) => resources[locale].email.mcp;

export interface NewConnectionMailInput {
  locale: AppLocale;
  name: string;
  client: string;
  redirectUri: string;
  scopes: McpScope[];
  spaces: string[] | null;
  expiresAt: Date | null;
  at: Date;
  ip: string | null;
  manageUrl: string;
  /** Set for the copy to org owners: the person who connected. */
  person?: { name: string; email: string };
}

/** "Yeni MCP bağlantısı" (design 18.3): a security notice, cannot be turned off. */
export function newConnectionMail(brand: MailBrand, input: NewConnectionMailInput): RenderedMail {
  const { locale } = input;
  const d = t(locale).newConnection;
  const orgName = brand.branding.orgName;
  const scopeNames = t(locale).scopeNames as Record<string, string>;
  const rows: [string, string][] = [
    [d.client, input.client],
    [d.redirect, input.redirectUri],
    [d.scopes, input.scopes.map((s) => scopeNames[s] ?? s).join(', ')],
    [d.spaces, input.spaces ? input.spaces.join(', ') : d.allSpaces],
    [d.expires, input.expiresAt ? formatDate(input.expiresAt, locale, false) : d.never],
    [d.when, formatDate(input.at, locale, true)],
  ];
  if (input.ip) rows.push([d.ip, input.ip]);
  const intro = input.person
    ? fill(d.adminIntro, {
        person: input.person.name,
        email: input.person.email,
        orgName,
        client: input.client,
      })
    : fill(d.intro, { name: input.name, client: input.client, orgName });
  const blocks = [
    heading(d.title),
    para(intro),
    facts(rows),
    button(d.cta, input.manageUrl, brand.accent),
    para(d.notMe, true),
    para(d.vault, true),
    fallbackLink(locale, input.manageUrl),
  ];
  return {
    subject: fill(d.subject, { orgName, client: input.client }),
    ...layout(brand, locale, blocks, [resources[locale].email.layout.securityFooter]),
  };
}

export interface ApprovalMailInput {
  locale: AppLocale;
  client: string;
  title: string;
  itemCount: number;
  expiresAt: Date;
  url: string;
}

export function approvalMail(brand: MailBrand, input: ApprovalMailInput): RenderedMail {
  const { locale } = input;
  const d = t(locale).approval;
  const blocks = [
    heading(fill(d.title, { client: input.client })),
    para(fill(d.intro, { client: input.client, title: input.title })),
    facts([[d.items, String(input.itemCount)]]),
    para(fill(d.expires, { time: formatDate(input.expiresAt, locale, true) }), true),
    button(d.cta, input.url, brand.accent),
    para(d.note, true),
    fallbackLink(locale, input.url),
  ];
  return {
    subject: fill(d.subject, { client: input.client, title: input.title }),
    ...layout(brand, locale, blocks, []),
  };
}
