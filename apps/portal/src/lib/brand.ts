import type { PortalHomeSection } from '@crewhall/shared';
import type { PortalSiteData } from '@/lib/hub';
import { mediaSrc } from '@/lib/site';

/**
 * Decorative brand images of the home page and footer. They come from the home page's hero
 * section (even when the section is hidden), by position:
 *
 * - `image` / `imageDark`: the brand mark (e.g. the bird) — also the footer's left logo
 * - `images[0]`: the hero card shape ("subtract")
 * - `images[1]`: the circuit background ("tech") — also the footer background
 * - `images[2]`: the vertical wordmark next to the card (desktop)
 * - `images[3]`: the horizontal wordmark (mobile hero, footer)
 *
 * Without a hero section the footer falls back to the navbar logo.
 */
export interface BrandImages {
  mark: string | null;
  markDark: string | null;
  card: string | null;
  tech: string | null;
  wordmarkVertical: string | null;
  wordmark: string | null;
  alt: string;
}

export function heroSection(site: PortalSiteData): PortalHomeSection | undefined {
  return site.home.sections.find((s) => s.type === 'hero');
}

export function brandImages(site: PortalSiteData): BrandImages {
  const hero = heroSection(site);
  const images = hero?.images ?? [];
  const logo = site.navigation.navbar.logo.src ? site.navigation.navbar.logo : site.settings.logo;
  return {
    mark: mediaSrc(hero?.image) ?? mediaSrc(logo.src),
    markDark: mediaSrc(hero?.imageDark),
    card: mediaSrc(images[0]),
    tech: mediaSrc(images[1]),
    wordmarkVertical: mediaSrc(images[2]),
    wordmark: mediaSrc(images[3]),
    alt: logo.alt || site.settings.title,
  };
}
