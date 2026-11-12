'use client';

import { useState, type MouseEvent } from 'react';
import { SiteLink } from '@/components/SiteLink';
import { useCloseDrawer } from '@/components/layout/drawer-context';

export interface SidebarNode {
  kind: 'doc' | 'category';
  label: string;
  /** Own link: doc page, category index or linked doc. */
  href: string | null;
  collapsed: boolean;
  items: SidebarNode[];
}

interface Props {
  items: SidebarNode[];
  activePath: string;
  labels: { expand: string; collapse: string };
}

const normalize = (p: string) => p.replace(/\/+$/, '') || '/';

function contains(node: SidebarNode, path: string): boolean {
  if (node.href && normalize(node.href) === path) return true;
  return node.items.some((c) => contains(c, path));
}

function firstHref(node: SidebarNode): string | null {
  if (node.href) return node.href;
  for (const c of node.items) {
    const h = firstHref(c);
    if (h) return h;
  }
  return null;
}

function Item({
  node,
  level,
  activePath,
  labels,
}: {
  node: SidebarNode;
  level: number;
  activePath: string;
  labels: Props['labels'];
}) {
  const close = useCloseDrawer();
  const active = contains(node, activePath);
  const [expanded, setExpanded] = useState(node.kind === 'category' && (!node.collapsed || active));

  // expand the category of the current page after client-side navigation
  const [seenPath, setSeenPath] = useState(activePath);
  if (seenPath !== activePath) {
    setSeenPath(activePath);
    if (active && !expanded) setExpanded(true);
  }

  if (node.kind === 'doc') {
    const isActive = !!node.href && normalize(node.href) === activePath;
    return (
      <li
        className={`theme-doc-sidebar-item-link theme-doc-sidebar-item-link-level-${level} menu__list-item`}
      >
        <SiteLink
          className={`menu__link${isActive ? ' menu__link--active' : ''}`}
          aria-current={isActive ? 'page' : undefined}
          href={node.href ?? '#'}
          {...(level > 1 ? { tabIndex: 0 } : {})}
        >
          <span title={node.label} className="linkLabel_WmDU" onClick={close}>
            {node.label}
          </span>
        </SiteLink>
      </li>
    );
  }

  const label = (expanded ? labels.collapse : labels.expand).replace('{label}', node.label);
  const ownActive = !!node.href && normalize(node.href) === activePath;
  const linkClass = `categoryLink_byQd menu__link menu__link--sublist${node.href ? '' : ' menu__link--sublist-caret'}${active ? ' menu__link--active' : ''}`;

  const onLinkClick = (e: MouseEvent) => {
    if (!node.href) {
      // category without its own page: the label toggles it
      e.preventDefault();
      setExpanded((v) => !v);
      return;
    }
    if (!expanded) setExpanded(true);
    close();
  };

  return (
    <li
      className={`theme-doc-sidebar-item-category theme-doc-sidebar-item-category-level-${level} menu__list-item${expanded ? '' : ' menu__list-item--collapsed'}`}
    >
      <div
        className={`menu__list-item-collapsible${ownActive ? ' menu__list-item-collapsible--active' : ''}`}
      >
        {node.href ? (
          <SiteLink
            className={linkClass}
            href={node.href}
            aria-current={ownActive ? 'page' : undefined}
          >
            <span title={node.label} className="categoryLinkLabel_W154" onClick={onLinkClick}>
              {node.label}
            </span>
          </SiteLink>
        ) : (
          <a
            className={linkClass}
            role="button"
            aria-expanded={expanded}
            href={firstHref(node) ?? '#'}
            onClick={onLinkClick}
          >
            <span title={node.label} className="categoryLinkLabel_W154">
              {node.label}
            </span>
          </a>
        )}
        {node.href && (
          <button
            aria-label={label}
            aria-expanded={expanded}
            type="button"
            className="clean-btn menu__caret"
            onClick={() => setExpanded((v) => !v)}
          />
        )}
      </div>
      {expanded && (
        <ul className="menu__list">
          {node.items.map((c, i) => (
            <Item key={i} node={c} level={level + 1} activePath={activePath} labels={labels} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Docusaurus doc sidebar menu (desktop aside and mobile drawer). */
export function DocSidebarMenu({ items, activePath, labels }: Props) {
  const path = normalize(activePath);
  return (
    <ul className="theme-doc-sidebar-menu menu__list">
      {items.map((node, i) => (
        <Item key={i} node={node} level={1} activePath={path} labels={labels} />
      ))}
    </ul>
  );
}
