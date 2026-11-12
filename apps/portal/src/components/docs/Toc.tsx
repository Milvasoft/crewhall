'use client';

import { useEffect, useState } from 'react';
import type { TocItem } from '@/render/Markdown';

function flatten(items: TocItem[]): string[] {
  return items.flatMap((i) => [i.id, ...flatten(i.children)]);
}

/** Docusaurus' TOC highlight: the first heading below the navbar, or the one above it. */
function useActiveHeading(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!ids.length) return;
    const update = () => {
      const navbar = document.querySelector('.navbar');
      const offset = navbar ? navbar.getBoundingClientRect().height : 0;
      const anchors = ids
        .map((id) => document.getElementById(id))
        .filter((el): el is HTMLElement => el !== null);
      const next = anchors.find((a) => a.getBoundingClientRect().top >= offset);
      let current: HTMLElement | null | undefined;
      if (next) {
        const rect = next.getBoundingClientRect();
        const topHalf = rect.top > 0 && rect.bottom < window.innerHeight / 2;
        current = topHalf ? next : anchors[anchors.indexOf(next) - 1];
      } else current = anchors[anchors.length - 1];
      setActive(current?.id ?? null);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [ids]);
  return active;
}

function TocList({
  items,
  active,
  className,
}: {
  items: TocItem[];
  active: string | null;
  className?: string;
}) {
  return (
    <ul className={className}>
      {items.map((item) => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            className={`table-of-contents__link toc-highlight${active === item.id ? ' table-of-contents__link--active' : ''}`}
          >
            {item.text}
          </a>
          {item.children.length > 0 && <TocList items={item.children} active={active} />}
        </li>
      ))}
    </ul>
  );
}

/** Right-hand "On this page" list with scroll spy. */
export function TocDesktop({ items, docs = true }: { items: TocItem[]; docs?: boolean }) {
  const [ids] = useState(() => flatten(items));
  const active = useActiveHeading(ids);
  return (
    <div className={`tableOfContents_bqdL thin-scrollbar${docs ? ' theme-doc-toc-desktop' : ''}`}>
      <TocList
        items={items}
        active={active}
        className="table-of-contents table-of-contents__left-border"
      />
    </div>
  );
}

/** Collapsible TOC above the content below 997px. */
export function TocMobile({ items, label }: { items: TocItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`tocCollapsible_ETCw theme-doc-toc-mobile tocMobile_ITEo${open ? ' tocCollapsibleExpanded_sAul' : ''}`}
    >
      <button
        type="button"
        className={`clean-btn tocCollapsibleButton_TO0P${open ? ' tocCollapsibleButtonExpanded_MG3E' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <div className="tocCollapsibleContent_vkbj" onClick={() => setOpen(false)}>
          <TocList items={items} active={null} className="table-of-contents" />
        </div>
      )}
    </div>
  );
}
