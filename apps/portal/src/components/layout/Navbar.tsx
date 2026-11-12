'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SiteLink } from '@/components/SiteLink';
import { ColorModeToggle } from '@/components/layout/ColorModeToggle';
import { DrawerContext } from '@/components/layout/drawer-context';
import { SearchBar } from '@/components/search/SearchBar';

export interface NavLinkData {
  kind: 'link';
  label: string;
  href: string;
  external: boolean;
  active: boolean;
}

export interface NavDropdownData {
  kind: 'dropdown';
  variant: 'locale' | 'version';
  label: string;
  href: string;
  items: { label: string; href: string; active: boolean; lang?: string }[];
}

export type NavItemData = NavLinkData | NavDropdownData;

export interface NavbarLabels {
  mainNavigation: string;
  toggleNavigation: string;
  closeNavigation: string;
  backToMainMenu: string;
  opensInNewTab: string;
  colorMode: { aria: string; light: string; dark: string; system: string };
  search: { placeholder: string; seeAll: string; noResults: string };
}

interface Props {
  brand: {
    href: string;
    title: string;
    logo: { src: string; srcDark: string | null; alt: string } | null;
  };
  left: NavItemData[];
  right: NavItemData[];
  labels: NavbarLabels;
  search: { locale: string; version: string | null; searchPagePath: string };
  /** Mobile drawer content shown first (doc sidebar, recent posts). */
  secondary: ReactNode | null;
}

const ExternalIcon = ({ label }: { label: string }) => (
  <svg width="13.5" height="13.5" aria-label={label} className="iconExternalLink_nPIU">
    <use href="#theme-svg-external-link" />
  </svg>
);

const LanguageIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className="iconLanguage_nlXk">
    <path
      fill="currentColor"
      d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"
    />
  </svg>
);

function Brand({ brand }: { brand: Props['brand'] }) {
  return (
    <SiteLink className="navbar__brand" href={brand.href}>
      {brand.logo?.src && (
        <div className="navbar__logo">
          {/* Docusaurus' ThemedImage keeps only the current theme's image after hydration */}
          <img
            src={brand.logo.src}
            alt={brand.logo.alt}
            className={`themedComponent_mlkZ themedComponent--light_NVdE${brand.logo.srcDark ? ' themed-light' : ''}`}
          />
          {brand.logo.srcDark && (
            <img
              src={brand.logo.srcDark}
              alt={brand.logo.alt}
              className="themedComponent_mlkZ themedComponent--dark_xIcU themed-dark"
            />
          )}
        </div>
      )}
      <b className="navbar__title text--truncate">{brand.title}</b>
    </SiteLink>
  );
}

function DesktopDropdown({ item }: { item: NavDropdownData }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!show) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [show]);
  const isLocale = item.variant === 'locale';
  return (
    <div
      ref={ref}
      className={`navbar__item dropdown dropdown--hoverable dropdown--right${show ? ' dropdown--show' : ''}`}
    >
      <a
        href={isLocale ? '#' : item.href}
        aria-haspopup="true"
        aria-expanded={show}
        role="button"
        className="navbar__link"
        onClick={(e) => {
          e.preventDefault();
          setShow((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            setShow((v) => !v);
          }
        }}
      >
        {isLocale && <LanguageIcon />}
        {item.label}
      </a>
      <ul className="dropdown__menu">
        {item.items.map((sub) => (
          <li key={sub.href + sub.label}>
            {isLocale ? (
              // switching language is a full page load (another root layout)
              <a
                href={sub.href}
                target="_self"
                rel="noopener noreferrer"
                className={`dropdown__link${sub.active ? ' dropdown__link--active' : ''}`}
                lang={sub.lang}
              >
                {sub.label}
              </a>
            ) : (
              <SiteLink
                className={`dropdown__link${sub.active ? ' dropdown__link--active' : ''}`}
                aria-current={sub.active ? 'page' : undefined}
                href={sub.href}
              >
                {sub.label}
              </SiteLink>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DesktopItem({ item, labels }: { item: NavItemData; labels: NavbarLabels }) {
  if (item.kind === 'dropdown') return <DesktopDropdown item={item} />;
  return (
    <SiteLink
      className={`navbar__item navbar__link${item.active ? ' navbar__link--active' : ''}`}
      aria-current={item.active ? 'page' : undefined}
      href={item.href}
    >
      {item.label}
      {item.external && <ExternalIcon label={labels.opensInNewTab} />}
    </SiteLink>
  );
}

function MobileItem({ item, labels }: { item: NavItemData; labels: NavbarLabels }) {
  const [open, setOpen] = useState(false);
  if (item.kind === 'link') {
    return (
      <li className="menu__list-item">
        <SiteLink
          className={`menu__link${item.active ? ' menu__link--active' : ''}`}
          aria-current={item.active ? 'page' : undefined}
          href={item.href}
        >
          {item.label}
          {item.external && <ExternalIcon label={labels.opensInNewTab} />}
        </SiteLink>
      </li>
    );
  }
  return (
    <li className={`menu__list-item${open ? '' : ' menu__list-item--collapsed'}`}>
      <a
        role="button"
        className="menu__link menu__link--sublist menu__link--sublist-caret dropdownNavbarItemMobile_J0Sd"
        href={item.variant === 'locale' ? '#' : item.href}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        {item.variant === 'locale' && <LanguageIcon />}
        {item.label}
      </a>
      {open && (
        <ul className="menu__list">
          {item.items.map((sub) => (
            <li key={sub.href + sub.label} className="menu__list-item">
              <a
                className={`menu__link${sub.active ? ' menu__link--active' : ''}`}
                href={sub.href}
                {...(sub.lang ? { lang: sub.lang } : {})}
              >
                {sub.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Docusaurus navbar: fixed, transparent until scrolled (old site's navbarSolid effect), mobile drawer. */
export function Navbar({ brand, left, right, labels, search, secondary }: Props) {
  const pathname = usePathname();
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const [showSecondary, setShowSecondary] = useState(true);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 50);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // close the drawer after navigation
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      close();
    }
  }, [pathname, close]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const toggle = () => {
    setShowSecondary(true);
    setOpen((v) => !v);
  };

  const hasSecondary = secondary !== null;
  return (
    <DrawerContext.Provider value={close}>
      <nav
        aria-label={labels.mainNavigation}
        className={`theme-layout-navbar navbar navbar--fixed-top${open ? ' navbar-sidebar--show' : ''}${solid ? ' navbarSolid' : ''}`}
      >
        <div className={`navbar__inner${solid ? ' navbarSolid' : ''}`}>
          <div className="theme-layout-navbar-left navbar__items">
            <button
              aria-label={labels.toggleNavigation}
              aria-expanded={open}
              className="navbar__toggle clean-btn"
              type="button"
              onClick={toggle}
            >
              <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
                <path
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeMiterlimit="10"
                  strokeWidth="2"
                  d="M4 7h22M4 15h22M4 23h22"
                />
              </svg>
            </button>
            <Brand brand={brand} />
            {left.map((item, i) => (
              <DesktopItem key={i} item={item} labels={labels} />
            ))}
          </div>
          <div className="theme-layout-navbar-right navbar__items navbar__items--right">
            {right.map((item, i) => (
              <DesktopItem key={i} item={item} labels={labels} />
            ))}
            <ColorModeToggle labels={labels.colorMode} className="colorModeToggle_DEke" />
            <div className="navbarSearchContainer_Bca1">
              <SearchBar
                locale={search.locale}
                version={search.version}
                searchPagePath={search.searchPagePath}
                labels={labels.search}
              />
            </div>
          </div>
        </div>
        <div role="presentation" className="navbar-sidebar__backdrop" onClick={close} />
        {open && (
          <div className="navbar-sidebar">
            <div className="navbar-sidebar__brand">
              <Brand brand={brand} />
              <ColorModeToggle labels={labels.colorMode} className="margin-right--md" />
              <button
                type="button"
                aria-label={labels.closeNavigation}
                className="clean-btn navbar-sidebar__close"
                onClick={close}
              >
                <svg viewBox="0 0 15 15" width="21" height="21">
                  <g stroke="var(--ifm-color-emphasis-600)" strokeWidth="1.2">
                    <path d="M.75.75l13.5 13.5M14.25.75L.75 14.25" />
                  </g>
                </svg>
              </button>
            </div>
            <div
              className={`navbar-sidebar__items${hasSecondary && showSecondary ? ' navbar-sidebar__items--show-secondary' : ''}`}
            >
              <div className="navbar-sidebar__item menu">
                <ul className="menu__list">
                  {[...left, ...right].map((item, i) => (
                    <MobileItem key={i} item={item} labels={labels} />
                  ))}
                </ul>
              </div>
              <div className="navbar-sidebar__item menu">
                {hasSecondary && (
                  <>
                    <button
                      type="button"
                      className="clean-btn navbar-sidebar__back"
                      onClick={() => setShowSecondary(false)}
                    >
                      {labels.backToMainMenu}
                    </button>
                    {secondary}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </nav>
    </DrawerContext.Provider>
  );
}
