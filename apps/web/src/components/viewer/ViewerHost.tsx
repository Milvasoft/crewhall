import { MediaViewer, toast, type ViewerItem } from '@crewhall/ui';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { desktopBridge, desktopHas } from '@/lib/desktop';
import { THIN_TITLE_ROW, useLendTitleBarColors } from '@/lib/desktop-titlebar';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useReducedMotion } from '@/lib/motion';
import {
  asBlobUrl,
  closeViewer,
  kindOf,
  openViewer,
  setViewerIndex,
  useViewer,
  type ViewerSource,
  type ViewerState,
} from '@/lib/viewer';

/** Blob URLs (PDFs, decrypted vault files) live only while the viewer is open. */
const blobs = new Set<string>();

async function resolve(src: ViewerSource, signal: AbortSignal): Promise<string> {
  let url = await src.url();
  if (kindOf(src.mime, src.name) === 'pdf' && !url.startsWith('blob:')) {
    url = await asBlobUrl(url, 'application/pdf', signal);
  }
  if (url.startsWith('blob:')) blobs.add(url);
  return url;
}

/** Signed URLs live a few minutes; refetch before they run out. */
const URL_MS = 4 * 60_000;

/** The shared media viewer, mounted once in the shell (see lib/viewer). */
export function ViewerHost() {
  const { t, locale } = useI18n();
  const live = useViewer();
  // Keep the last items while the close animation plays.
  const [last, setLast] = useState<ViewerState | null>(live);
  if (live && live !== last) setLast(live);
  const shown = live ?? last;
  const reduced = useReducedMotion();
  // The viewer's bar mounts a render after it opens (the dialog's portal): a ref is still empty then.
  const [barEl, setBar] = useState<HTMLDivElement | null>(null);
  const bar = useMemo(() => ({ current: barEl }), [barEl]);
  useLendTitleBarColors(bar, Boolean(live), THIN_TITLE_ROW);
  const qc = useQueryClient();
  // Desktop app: our own files a page opened in a new window come back here (no bare window).
  useEffect(() => {
    if (!desktopHas('openFile')) return;
    return desktopBridge()?.onOpenFile?.((file) =>
      openViewer([{ key: file.url, name: file.name, mime: null, url: async () => file.url }]),
    );
  }, []);
  useEffect(() => {
    if (live) return;
    qc.removeQueries({ queryKey: ['viewer'] });
    blobs.forEach((u) => URL.revokeObjectURL(u));
    blobs.clear();
  }, [live, qc]);

  const items = shown?.items ?? [];
  const index = shown?.index ?? 0;
  // The current item and its neighbours, so arrows switch without a wait.
  const near = useMemo(
    () =>
      items.length
        ? [
            ...new Set([
              index,
              (index + 1) % items.length,
              (index - 1 + items.length) % items.length,
            ]),
          ]
        : [],
    [items.length, index],
  );
  const urls = useQueries({
    queries: near.map((i) => {
      const src = items[i] as ViewerSource;
      return {
        queryKey: ['viewer', src.key],
        queryFn: ({ signal }: { signal: AbortSignal }) => resolve(src, signal),
        staleTime: URL_MS,
        gcTime: URL_MS,
        enabled: Boolean(live),
      };
    }),
  });
  const urlOf = (i: number) => {
    const at = near.indexOf(i);
    return at >= 0 ? (urls[at]?.data ?? null) : null;
  };

  const viewItems: ViewerItem[] = items.map((s, i) => ({
    key: s.key,
    name: s.name,
    kind: kindOf(s.mime, s.name),
    src: urlOf(i),
    thumb: s.thumb ?? null,
    meta: s.sizeBytes !== undefined ? formatBytes(s.sizeBytes, locale) : undefined,
  }));
  const sourceOf = (item: ViewerItem) => items.find((s) => s.key === item.key);
  const current = items[index];

  return (
    <MediaViewer
      open={Boolean(live)}
      onOpenChange={(v) => {
        if (!v) closeViewer();
      }}
      items={viewItems}
      index={index}
      onIndexChange={setViewerIndex}
      origin={shown?.origin}
      reducedMotion={reduced}
      barRef={setBar}
      labels={{
        close: t('viewer.close'),
        prev: t('viewer.prev'),
        next: t('viewer.next'),
        zoomIn: t('viewer.zoomIn'),
        zoomOut: t('viewer.zoomOut'),
        download: t('viewer.download'),
        openInTab: t('viewer.openInTab'),
        copyLink: t('viewer.copyLink'),
        counter: (i, n) => t('viewer.counter', { n: i, total: n }),
        noPreview: t('viewer.noPreview'),
      }}
      onDownload={(item) => {
        const src = sourceOf(item);
        if (!src) return;
        void (src.download ?? src.url)()
          .then((url) => {
            // An anchor works for signed URLs and for in-memory blobs (vault) alike.
            const link = document.createElement('a');
            link.href = url;
            link.download = src.name;
            link.click();
          })
          .catch(() => toast.error(t('viewer.failed')));
      }}
      onOpenInTab={
        current?.private
          ? undefined
          : (item) => {
              if (item.src) window.open(item.src, '_blank', 'noopener');
            }
      }
      onCopyLink={
        current?.link
          ? (item) => {
              const link = sourceOf(item)?.link;
              if (!link) return;
              void navigator.clipboard
                .writeText(new URL(link, window.location.origin).toString())
                .then(() => toast(t('viewer.linkCopied')))
                .catch(() => undefined);
            }
          : undefined
      }
    />
  );
}
