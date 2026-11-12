import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { RAW_PATHS } from '@crewhall/shared';
import { config } from '@/config';
import { api } from '@/lib/api';
import { canView, openViewer, type ViewerSource } from '@/lib/viewer';
import { driveNodeSource } from '@/lib/viewerSources';

/**
 * Drive files in page bodies (H18): imported images and attachments are stored as
 * `node:<fileId>`, so the page does not depend on one host or one way of signing in. Each place
 * that shows a page turns them into a URL it can load (here: the signed-in download redirect).
 */

const NODE_SRC = /^node:([0-9a-f-]{36})$/i;

export const nodeIdOfSrc = (src: string): string | null => NODE_SRC.exec(src)?.[1] ?? null;

/** `node:<id>` → the download redirect (session cookie); anything else stays as it is. */
export function resolveNodeSrc(src: string): string {
  const id = nodeIdOfSrc(src);
  return id ? `${config.apiUrl}${RAW_PATHS.download.replace(':nodeId', id)}` : src;
}

const DOWNLOAD_ID = /\/nodes\/([0-9a-f-]{36})\/download/i;

/** Every picture of the page, so the viewer's arrows walk through them in order. */
function pageImages(root: Element): { el: HTMLImageElement; source: ViewerSource }[] {
  return [...root.querySelectorAll('img')].map((el, i) => {
    const id = DOWNLOAD_ID.exec(el.currentSrc || el.src)?.[1];
    const name = el.alt || `image-${i + 1}`;
    const source = id
      ? driveNodeSource({ id, name, mime: 'image/*' })
      : { key: `img:${el.src}`, name, mime: 'image/*', url: () => Promise.resolve(el.src) };
    return { el, source: { ...source, thumb: el.currentSrc || el.src } };
  });
}

/** A Drive file linked from a page: images, videos and PDFs open in the viewer. */
async function openNodeLink(nodeId: string, from: Element): Promise<void> {
  const node = await api.call('getNode', { params: { nodeId } }).catch(() => null);
  if (node && node.type === 'file' && canView(node.mime, node.name)) {
    openViewer([driveNodeSource(node)], 0, from);
    return;
  }
  window.location.assign(resolveNodeSrc(`node:${nodeId}`));
}

/**
 * A click on a `node:` link opens the file (in the viewer when it can be shown) instead of the
 * unknown scheme; reading a page, a click on a picture opens it in the viewer.
 */
export const NodeLinks = Extension.create({
  name: 'nodeLinks',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('nodeLinks'),
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              const target = event.target as Element | null;
              const img = target?.closest?.('img');
              if (img && !view.editable) {
                const all = pageImages(view.dom);
                const at = all.findIndex((x) => x.el === img);
                openViewer(
                  all.map((x) => x.source),
                  Math.max(0, at),
                  img,
                );
                return true;
              }
              const a = target?.closest?.('a[href^="node:"]');
              const id = nodeIdOfSrc(a?.getAttribute('href') ?? '');
              if (!a || !id) return false;
              event.preventDefault();
              void openNodeLink(id, a);
              return true;
            },
          },
        },
      }),
    ];
  },
});
