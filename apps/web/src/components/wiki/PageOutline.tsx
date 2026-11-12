import {
  headingElement,
  outlineDepth,
  scrollToHeading,
  useOutline,
  type OutlineItem,
} from '@crewhall/editor/react';
import { cn } from '@crewhall/ui';
import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/** A heading counts as being read once it has passed this far below the top of the scroller. */
const READING_LINE_PX = 96;
/** A jump scrolls smoothly; the heading that was picked stays lit until it lands. */
const JUMP_HOLD_MS = 900;
/** One heading is no outline. */
const MIN_ITEMS = 2;

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

/** The heading being read: the last one above the reading line, the last of all at the bottom. */
function readingNow(editor: Editor, items: OutlineItem[]): number | null {
  if (editor.isDestroyed) return null;
  const scroller = scrollerOf(editor.view.dom);
  if (!scroller) return null;
  const line = scroller.getBoundingClientRect().top + READING_LINE_PX;
  let reading: number | null = null;
  for (const item of items) {
    const el = headingElement(editor, item.pos);
    if (el && el.getBoundingClientRect().top <= line) reading = item.pos;
  }
  const scrolls = scroller.scrollHeight > scroller.clientHeight + 2 && scroller.scrollTop > 0;
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  return scrolls && atEnd ? (items[items.length - 1]?.pos ?? null) : reading;
}

/**
 * The page and, beside it, its live outline (Outline/Notion): the page stays centred, the
 * outline takes the free column on the right and folds into small lines when the column is
 * narrow. Without room for even those, or without headings, the page is laid out as before.
 */
export function PageOutlineLayout({
  editor,
  enabled,
  fullWidth,
  className,
  children,
}: {
  editor: Editor | null;
  /** Off beside a side panel and in the version view. */
  enabled: boolean;
  fullWidth: boolean;
  className?: string;
  children: ReactNode;
}) {
  const items = useOutline(enabled ? editor : null);
  const shown = items.length >= MIN_ITEMS;
  return (
    <div className={cn('wk-page', shown && fullWidth && 'wk-page--full', className)}>
      {children}
      {shown && editor ? <PageOutline editor={editor} items={items} /> : null}
    </div>
  );
}

function PageOutline({ editor, items }: { editor: Editor; items: OutlineItem[] }) {
  const { t } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const holdUntil = useRef(0);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (Date.now() >= holdUntil.current) setActive(readingNow(editor, items));
      });
    };
    measure();
    // The scroller is the app shell's, and scroll events reach window only while capturing.
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
    };
  }, [editor, items]);

  return (
    <aside className="wk-outline-col wk-noprint">
      <nav className="wk-outline" aria-label={t('wiki.outline.label')}>
        <p className="wk-outline-title eyebrow">{t('wiki.outline.label')}</p>
        <ul>
          {items.map((item) => (
            <li key={item.pos}>
              <button
                type="button"
                className="wk-outline-item"
                style={{ '--wk-outline-depth': outlineDepth(items, item) } as CSSProperties}
                aria-current={active === item.pos ? 'location' : undefined}
                onClick={() => {
                  holdUntil.current = Date.now() + JUMP_HOLD_MS;
                  setActive(item.pos);
                  scrollToHeading(editor, item.pos);
                }}
              >
                <span className="wk-outline-text">{item.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
