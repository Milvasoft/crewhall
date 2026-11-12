import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Image } from '@tiptap/extension-image';
import { common, createLowlight } from 'lowlight';
import { imageWidth, isImageAlign } from '../../model';

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const MIN_WIDTH = 10;

/**
 * Inline image with `src`, `alt`, `title`, and its layout: `width` in percent of the block and
 * `align`. Markdown keeps only the first three. An image with a layout stands on its own line.
 * `resolveUrl` maps a stored src (e.g. `/media/img/a.png`) to a loadable URL in the editor only;
 * the stored src never changes.
 */
export function createImage(resolveUrl?: (src: string) => string) {
  return Image.extend({
    addAttributes() {
      return {
        src: { default: null },
        alt: { default: null },
        title: { default: null },
        width: {
          default: null,
          parseHTML: (el: HTMLElement) => imageWidth(el.getAttribute('data-width')),
          renderHTML: (attrs: Record<string, unknown>) => {
            const width = imageWidth(attrs.width);
            return width ? { 'data-width': String(width) } : {};
          },
        },
        align: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            const align = el.getAttribute('data-align');
            return isImageAlign(align) ? align : null;
          },
          renderHTML: (attrs: Record<string, unknown>) =>
            isImageAlign(attrs.align) ? { 'data-align': attrs.align } : {},
        },
      };
    },

    addNodeView() {
      return ({ node: initial, getPos, editor }) => {
        let node = initial;
        const dom = document.createElement('span');
        dom.className = 'ch-image-wrap';
        const img = document.createElement('img');
        img.className = 'ch-image';
        img.draggable = true;
        const handle = document.createElement('span');
        handle.className = 'ch-image-handle';
        handle.setAttribute('aria-hidden', 'true');
        dom.append(img, handle);
        const layout = () => {
          const width = imageWidth(node.attrs.width);
          const align = isImageAlign(node.attrs.align) ? node.attrs.align : null;
          dom.style.width = width ? `${width}%` : '';
          dom.classList.toggle('has-layout', Boolean(width || align));
          if (align) dom.dataset.align = align;
          else delete dom.dataset.align;
        };
        handle.addEventListener('pointerdown', (down) => {
          const parent = dom.parentElement?.getBoundingClientRect().width ?? 0;
          if (!editor.isEditable || !parent) return;
          down.preventDefault();
          down.stopPropagation();
          const start = dom.getBoundingClientRect().width;
          // A centred image grows on both sides, a right-aligned one to the left.
          const factor = node.attrs.align === 'center' ? 2 : node.attrs.align === 'right' ? -1 : 1;
          let next: number | null = null;
          const move = (e: PointerEvent) => {
            const px = start + (e.clientX - down.clientX) * factor;
            next = Math.min(100, Math.max(MIN_WIDTH, Math.round((px / parent) * 100)));
            dom.classList.add('has-layout');
            dom.style.width = `${next}%`;
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            const pos = getPos();
            if (next === null || typeof pos !== 'number') return;
            editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'width', next));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });
        const sync = () => {
          layout();
          const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
          img.src = resolveUrl && src ? resolveUrl(src) : src;
          const alt = str(node.attrs.alt);
          const title = str(node.attrs.title);
          img.alt = alt ?? '';
          if (title) img.title = title;
          else img.removeAttribute('title');
        };
        sync();
        return {
          dom,
          update: (updated) => {
            if (updated.type !== node.type) return false;
            node = updated;
            sync();
            return true;
          },
          stopEvent: (e) => e.target === handle,
          ignoreMutation: () => true,
        };
      };
    },
  }).configure({ inline: true, allowBase64: false });
}

const lowlight = createLowlight(common);

/** Fenced code with syntax highlighting; `title` and `meta` keep the rest of the fence line. */
export function createCodeBlock() {
  return CodeBlockLowlight.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        title: {
          default: null,
          parseHTML: (el: HTMLElement) => str(el.getAttribute('data-title')),
          renderHTML: (attrs: Record<string, unknown>) => {
            const title = str(attrs.title);
            return title ? { 'data-title': title } : {};
          },
        },
        meta: {
          default: null,
          parseHTML: (el: HTMLElement) => str(el.getAttribute('data-meta')),
          renderHTML: (attrs: Record<string, unknown>) => {
            const meta = str(attrs.meta);
            return meta ? { 'data-meta': meta } : {};
          },
        },
      };
    },
  }).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true, tabSize: 2 });
}
