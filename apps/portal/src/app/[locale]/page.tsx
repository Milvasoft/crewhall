import type { PortalHomeSection } from '@crewhall/shared';
import type { Metadata } from 'next';
import { Home, type HomeSectionData, type ThemedImage } from '@/components/home/Home';
import { Shell } from '@/components/layout/Shell';
import { strings } from '@/i18n';
import { brandImages, heroSection } from '@/lib/brand';
import type { PortalSiteData } from '@/lib/hub';
import { metaContext, pageContext } from '@/lib/page';
import { buildMetadata } from '@/lib/seo';
import { mediaSrc, text, withVersion } from '@/lib/site';
import { renderMarkdown } from '@/render/Markdown';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  const hero = heroSection(ctx.site);
  const description =
    ctx.site.settings.tagline ??
    (hero ? text(hero.description, locale, ctx.site.defaultLocale) : null);
  return buildMetadata({ site: ctx.site, locale, title: null, description, path: '/' });
}

const themed = (
  src: string | null | undefined,
  dark: string | null | undefined,
): ThemedImage | null => {
  const s = mediaSrc(src);
  return s ? { src: s, dark: mediaSrc(dark) } : null;
};

function toSections(site: PortalSiteData, locale: string): HomeSectionData[] {
  const s = strings(locale);
  const t = (v: Record<string, string> | undefined) =>
    withVersion(text(v, locale, site.defaultLocale), site);
  const visible = site.home.sections.filter((x) => !x.hidden);
  const videoOf = (x: PortalHomeSection | undefined) =>
    x?.videoId ? { id: x.videoId, title: t(x.title) || s.videoTitle } : null;
  const firstVideo = visible.find((x) => x.type === 'video');
  const hasAbout = visible.some((x) => x.type === 'about');
  const brand = brandImages(site);
  const out: HomeSectionData[] = [];
  for (const x of visible) {
    switch (x.type) {
      case 'hero':
        out.push({
          type: 'hero',
          id: x.id,
          title: t(x.title),
          badge: t(x.badge),
          description: t(x.description),
          card: brand.card,
          tech: brand.tech,
          wordmarkVertical: brand.wordmarkVertical,
          wordmark: brand.wordmark,
          mark: heroSection(site)?.image ? themed(x.image, x.imageDark) : null,
        });
        break;
      case 'about':
        out.push({
          type: 'about',
          id: x.id,
          title: t(x.title),
          description: t(x.description),
          video: videoOf(firstVideo),
        });
        break;
      case 'video': {
        // the old layout shows the video next to "Who We Are"
        const video = videoOf(x);
        if (video && (!hasAbout || x !== firstVideo)) out.push({ type: 'video', id: x.id, video });
        break;
      }
      case 'features':
        out.push({
          type: 'features',
          id: x.id,
          title: t(x.title),
          items: (x.items?.[locale] ?? x.items?.[site.defaultLocale] ?? []).map((i) =>
            withVersion(i, site),
          ),
          image: themed(x.image, x.imageDark),
          dot: mediaSrc(x.images?.[0]),
        });
        break;
      case 'technologies':
        out.push({
          type: 'technologies',
          id: x.id,
          title: t(x.title),
          description: t(x.description),
          icon: themed(x.image, x.imageDark),
          logos: (x.images ?? []).map((i) => mediaSrc(i)).filter((i): i is string => !!i),
        });
        break;
      case 'community':
        out.push({
          type: 'community',
          id: x.id,
          title: t(x.title),
          description: t(x.description),
          image: themed(x.image, x.imageDark),
        });
        break;
      case 'projects':
        out.push({
          type: 'projects',
          id: x.id,
          title: t(x.title),
          description: t(x.description),
          projects: (x.projects ?? []).map((p) => ({
            name: p.name,
            image: mediaSrc(p.image),
            url: p.url && /^https?:\/\//i.test(p.url) ? p.url : null,
            description: text(p.description, locale, site.defaultLocale),
            badges: p.badges,
          })),
        });
        break;
      case 'markdown':
        out.push({
          type: 'markdown',
          id: x.id,
          title: t(x.title),
          content: renderMarkdown(t(x.description), s).content,
        });
        break;
    }
  }
  return out;
}

function homeLabels(locale: string) {
  const s = strings(locale);
  return { scroll: s.homeScroll, chapters: s.homeChapters, video: s.videoTitle };
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  const { site } = await pageContext(locale);
  return (
    <Shell site={site} locale={locale} path="/">
      <Home sections={toSections(site, locale)} labels={homeLabels(locale)} />
    </Shell>
  );
}
