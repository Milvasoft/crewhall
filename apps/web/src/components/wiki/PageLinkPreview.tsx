import { plainText, type EditorDoc } from '@crewhall/editor';
import { pageIdFromRef } from '@crewhall/shared';
import { Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { pageQuery } from '@/lib/wiki/api';

const OPEN_AFTER_MS = 350;
/** Long enough to move the pointer from the link onto the card. */
const CLOSE_AFTER_MS = 150;
const EXCERPT_CHARS = 220;
const GAP = 6;
const MARGIN = 8;

/** The page a link inside the open page points to, whatever form its address has. */
function pageIdOfLink(link: HTMLAnchorElement): string | null {
  const href = link.getAttribute('href') ?? '';
  let path: string;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    path = url.pathname;
  } catch {
    return null;
  }
  return path.startsWith('/p/') ? pageIdFromRef(path) : null;
}

const linkOf = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLAnchorElement>('.wk-page a[href]') : null;

interface Hovered {
  id: string;
  link: HTMLAnchorElement;
}

/**
 * A small card about the page a link leads to: in the body, under "Alt sayfalar" and under the
 * backlinks. Opens on a pause over the link or on keyboard focus; a page the person cannot read
 * shows nothing, as the server does not give it out.
 */
export function PageLinkPreview({ currentId }: { currentId: string }) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    // A touch screen has no hover: a tap opens the link.
    if (window.matchMedia?.('(hover: none)').matches) return undefined;
    const later = (run: () => void, ms: number) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(run, ms);
    };
    const enter = (e: Event) => {
      const link = linkOf(e.target);
      if (!link) return;
      const id = pageIdOfLink(link);
      if (!id || id === currentId) return;
      later(() => setHovered({ id, link }), OPEN_AFTER_MS);
    };
    const leave = (e: Event) => {
      if (linkOf(e.target)) later(() => setHovered(null), CLOSE_AFTER_MS);
    };
    const close = () => {
      window.clearTimeout(timer.current);
      setHovered(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mouseover', enter);
    document.addEventListener('mouseout', leave);
    document.addEventListener('focusin', enter);
    document.addEventListener('focusout', leave);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener('mouseover', enter);
      document.removeEventListener('mouseout', leave);
      document.removeEventListener('focusin', enter);
      document.removeEventListener('focusout', leave);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, { capture: true });
    };
  }, [currentId]);

  if (!hovered) return null;
  return (
    <PreviewCard
      key={hovered.id}
      nodeId={hovered.id}
      anchor={hovered.link}
      onEnter={() => window.clearTimeout(timer.current)}
      onLeave={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setHovered(null), CLOSE_AFTER_MS);
      }}
    />
  );
}

function PreviewCard({
  nodeId,
  anchor,
  onEnter,
  onLeave,
}: {
  nodeId: string;
  anchor: HTMLElement;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { t, locale } = useI18n();
  const page = useQuery({ ...pageQuery(nodeId), retry: false });
  const content = useQuery({
    queryKey: ['wiki', 'preview', nodeId],
    queryFn: ({ signal }) =>
      api.call('getPageContent', {
        params: { nodeId },
        query: { format: 'json' },
        signal,
      }),
    retry: false,
    staleTime: 60_000,
  });
  const card = useRef<HTMLDivElement>(null);
  const data = page.data;
  const text = content.data?.doc ? plainText(content.data.doc as EditorDoc) : '';
  const excerpt = text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}…` : text;

  // Below the link, above it when there is no room; always inside the window.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const link = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const below = link.bottom + GAP + box.height <= window.innerHeight - MARGIN;
    el.style.top = `${below ? link.bottom + GAP : Math.max(MARGIN, link.top - GAP - box.height)}px`;
    const left = Math.min(link.left, window.innerWidth - box.width - MARGIN);
    el.style.left = `${Math.max(MARGIN, left)}px`;
  });

  if (!data) return null;
  return createPortal(
    <div
      ref={card}
      role="tooltip"
      className="wk-link-preview"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <p className="wk-link-preview-title">
        {data.icon ? <span>{data.icon}</span> : <Icon name="page" size={16} />}
        <span className="min-w-0 truncate">{data.name}</span>
      </p>
      {excerpt ? <p className="wk-link-preview-text">{excerpt}</p> : null}
      <p className="wk-link-preview-meta">
        {t('wiki.page.edited', {
          name: data.editedBy?.name ?? '',
          when: formatRelative(data.editedAt, locale),
        })}
      </p>
    </div>,
    document.body,
  );
}
