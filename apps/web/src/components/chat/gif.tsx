import { GIF_LIMITS, type GifResult, type MessageGif } from '@crewhall/shared';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Icon,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from '@crewhall/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { isReducedMotion } from '@/lib/motion';
import { useBootstrap } from '@/lib/useBranding';

/** GIFs in chat (GIPHY, the org's own key): picker, message view and helpers. */

/** The server lists `chat.gif` only while the org has GIFs on. */
export function useGifEnabled(): boolean {
  return useBootstrap().data?.server?.capabilities?.includes('chat.gif') ?? false;
}

/** A picked result as it goes into the message. */
export function toMessageGif(g: GifResult): MessageGif {
  return {
    provider: 'giphy',
    id: g.id,
    url: g.url,
    previewUrl: g.stillUrl,
    width: g.width,
    height: g.height,
    title: g.title,
  };
}

function useDebounced(value: string, ms: number) {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/** Search box over a grid that opens with trending and loads more as it scrolls. */
function GifGrid({
  initialQuery,
  onPick,
}: {
  initialQuery: string;
  onPick: (g: GifResult) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState(initialQuery);
  // Few GIPHY calls: a pause in typing, at least two letters, one key per search (the
  // query cache answers repeats), and a running request is cancelled when the search changes.
  const typed = useDebounced(q.trim().toLocaleLowerCase('tr'), 450);
  const query = typed.length >= GIF_LIMITS.minQuery ? typed : '';
  const end = useRef<HTMLDivElement>(null);
  const list = useInfiniteQuery({
    queryKey: ['chat', 'gifs', query],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      query
        ? api.call('searchGifs', {
            query: { q: query, offset: pageParam, limit: GIF_LIMITS.pageSize },
            signal,
          })
        : api.call('trendingGifs', {
            query: { offset: pageParam, limit: GIF_LIMITS.pageSize },
            signal,
          }),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    // Trending once per session; a search for an hour (the server caches as long).
    staleTime: query ? 60 * 60_000 : Infinity,
    gcTime: 60 * 60_000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  // Infinite scroll: the sentinel under the grid asks for the next page.
  useEffect(() => {
    const el = end.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // Only when the end of the grid is really in view.
    const io = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((e) => e.isIntersecting) &&
          list.hasNextPage &&
          !list.isFetchingNextPage &&
          !list.isError
        ) {
          void list.fetchNextPage();
        }
      },
      { threshold: 1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [list]);

  return (
    <div className="flex flex-col gap-2">
      <Input
        autoFocus
        value={q}
        maxLength={GIF_LIMITS.queryChars}
        placeholder={t('chat.gif.search')}
        aria-label={t('chat.gif.search')}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim().length > 0 && q.trim().length < GIF_LIMITS.minQuery ? (
        <p className="m-0 text-xs text-fg3">{t('chat.gif.minQuery')}</p>
      ) : null}
      <div className="h-[300px] overflow-y-auto overscroll-contain">
        {list.isError ? (
          <p className="m-0 p-3 text-center text-cap text-fg2">
            {isApiError(list.error) ? t(`errors.${list.error.code}`) : t('errors.internal')}
          </p>
        ) : list.isPending ? (
          <div className="flex justify-center p-6">
            <Spinner size={18} />
          </div>
        ) : items.length === 0 ? (
          <p className="m-0 p-3 text-center text-cap text-fg2">{t('chat.gif.empty')}</p>
        ) : (
          <div className="columns-2 gap-1.5" role="listbox" aria-label={t('chat.gif.results')}>
            {items.map((g) => (
              <button
                key={g.id}
                type="button"
                role="option"
                aria-selected={false}
                aria-label={g.title || t('chat.gif.untitled')}
                onClick={() => onPick(g)}
                className="mb-1.5 block w-full overflow-hidden rounded-md bg-bg2 focus-visible:outline-2"
                style={{ aspectRatio: `${g.previewWidth} / ${g.previewHeight}` }}
              >
                <img
                  src={g.previewUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="block h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        <div ref={end} className="h-4" />
        {list.isFetchingNextPage ? (
          <div className="flex justify-center p-2">
            <Spinner size={16} />
          </div>
        ) : null}
      </div>
      {/* Required by GIPHY's terms wherever its results are shown. */}
      <p className="m-0 text-right text-[11px] font-bold tracking-[.04em] text-fg2">
        {t('chat.gif.attribution')}
      </p>
    </div>
  );
}

/** The GIF button next to the emoji one (and `/gif <kelime>`). */
export function GifPicker({
  open,
  onOpenChange,
  initialQuery = '',
  onPick,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialQuery?: string;
  onPick: (g: GifResult) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-[340px] p-2"
        aria-label={t('chat.gif.picker')}
      >
        {open ? (
          <GifGrid
            initialQuery={initialQuery}
            onPick={(g) => {
              onPick(g);
              onOpenChange(false);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

const MAX_W = 320;
const MAX_H = 260;

/**
 * A GIF in a message at its own proportions; a click opens it large. With reduced motion it
 * shows the still frame and plays only on a click.
 */
export function GifView({ gif }: { gif: MessageGif }) {
  const { t } = useI18n();
  const still = isReducedMotion() && Boolean(gif.previewUrl);
  const [playing, setPlaying] = useState(!still);
  const [large, setLarge] = useState(false);
  const scale = Math.min(1, MAX_W / gif.width, MAX_H / gif.height);
  const w = Math.round(gif.width * scale);
  const h = Math.round(gif.height * scale);
  const label = gif.title || t('chat.gif.untitled');
  return (
    <>
      <button
        type="button"
        data-no-quick-react=""
        aria-label={
          playing ? t('chat.gif.open', { title: label }) : t('chat.gif.play', { title: label })
        }
        onClick={() => (playing ? setLarge(true) : setPlaying(true))}
        className="relative block max-w-full overflow-hidden rounded-xl bg-bg2"
        style={{ width: w, aspectRatio: `${gif.width} / ${gif.height}` }}
      >
        <img
          src={playing ? gif.url : (gif.previewUrl ?? gif.url)}
          alt={label}
          width={w}
          height={h}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="block h-full w-full object-cover"
        />
        {!playing ? (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25 text-white">
            <Icon name="play" size={28} />
          </span>
        ) : null}
        <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] font-bold text-white">
          GIF
        </span>
      </button>
      <Dialog open={large} onOpenChange={setLarge}>
        <DialogContent width={720}>
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <img
            src={gif.url}
            alt={label}
            referrerPolicy="no-referrer"
            className="mx-auto block max-h-[70vh] max-w-full rounded-lg"
          />
          <p className="m-0 text-right text-[11px] font-bold text-fg2">
            {t('chat.gif.attribution')}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
