import NextLink from 'next/link';
import type { ReactNode } from 'react';

export const isExternal = (href: string) =>
  /^(https?:)?\/\//i.test(href) || /^(mailto|tel):/i.test(href);

interface Props {
  href: string;
  className?: string | undefined;
  children?: ReactNode;
  'aria-label'?: string | undefined;
  'aria-current'?: 'page' | undefined;
  title?: string | undefined;
  rel?: string | undefined;
  lang?: string | undefined;
  tabIndex?: number | undefined;
  /** Open external links in a new tab (Docusaurus does for markdown and navbar links). */
  newTab?: boolean;
}

/**
 * Site link: client-side navigation for internal paths (no prefetch, so a long sidebar does
 * not render every page at once), a plain anchor for external and hash links.
 */
export function SiteLink({ href, children, newTab = true, rel, ...rest }: Props) {
  if (isExternal(href)) {
    return (
      <a
        href={href}
        {...(newTab ? { target: '_blank', rel: rel ?? 'noopener noreferrer' } : rel ? { rel } : {})}
        {...rest}
      >
        {children}
      </a>
    );
  }
  if (href.startsWith('#') || href.startsWith('/api/') || href.startsWith('/media/')) {
    return (
      <a href={href} rel={rel} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <NextLink href={href} prefetch={false} rel={rel} {...rest}>
      {children}
    </NextLink>
  );
}
