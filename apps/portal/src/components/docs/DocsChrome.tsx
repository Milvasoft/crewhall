import type { ReactNode } from 'react';
import { BackToTop } from '@/components/layout/BackToTop';
import { DocSidebarMenu, type SidebarNode } from '@/components/docs/DocSidebarMenu';
import type { SiteStrings } from '@/i18n';

/** Docusaurus docs root: sidebar aside + main container. */
export function DocsChrome({
  nodes,
  activePath,
  s,
  children,
}: {
  nodes: SidebarNode[];
  activePath: string;
  s: SiteStrings;
  children: ReactNode;
}) {
  return (
    <div className="docsWrapper_hBAB">
      <BackToTop label={s.backToTop} />
      <div className="docRoot_UBD9">
        <aside className="theme-doc-sidebar-container docSidebarContainer_YfHR">
          <div className="sidebarViewport_aRkj">
            <div className="sidebar_njMd">
              <nav aria-label={s.docsSidebar} className="menu thin-scrollbar menu_SIkG">
                <DocSidebarMenu
                  items={nodes}
                  activePath={activePath}
                  labels={{ expand: s.expandCategory, collapse: s.collapseCategory }}
                />
              </nav>
            </div>
          </div>
        </aside>
        <main className="docMainContainer_TBSr">{children}</main>
      </div>
    </div>
  );
}

/** The doc sidebar for the mobile drawer. */
export function MobileDocSidebar({
  nodes,
  activePath,
  s,
}: {
  nodes: SidebarNode[];
  activePath: string;
  s: SiteStrings;
}) {
  return (
    <DocSidebarMenu
      items={nodes}
      activePath={activePath}
      labels={{ expand: s.expandCategory, collapse: s.collapseCategory }}
    />
  );
}
