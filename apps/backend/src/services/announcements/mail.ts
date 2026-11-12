import { resources, type AppLocale } from '@crewhall/i18n';
import { fill, mailParts, type MailBrand, type RenderedMail } from '../../mail/templates';

const { layout, heading, para, button, fallbackLink } = mailParts;

export interface AnnouncementMailInput {
  title: string;
  body: string;
  authorName: string | null;
  requiresAck: boolean;
  url: string;
}

/** A published announcement (roadmap 19): title, the text as paragraphs, a button to open it. */
export function announcementMail(
  brand: MailBrand,
  locale: AppLocale,
  input: AnnouncementMailInput,
): RenderedMail {
  const t = resources[locale].email.announcements;
  const orgName = brand.branding.orgName;
  const by = input.authorName
    ? fill(t.byAuthor, { author: input.authorName, orgName })
    : fill(t.byOrg, { orgName });
  const paragraphs = input.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => para(p));
  const blocks = [
    para(by, true),
    heading(input.title),
    ...paragraphs,
    ...(input.requiresAck ? [para(t.ackNeeded)] : []),
    button(input.requiresAck ? t.ackCta : t.cta, input.url, brand.accent),
    fallbackLink(locale, input.url),
  ];
  return {
    subject: fill(t.subject, { orgName, title: input.title }),
    ...layout(brand, locale, blocks, [fill(t.footerWhy, { orgName }), t.footerManage]),
  };
}
