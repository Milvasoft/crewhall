import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { cn } from '../cn';
import { Icon, type IconName } from '../icons/Icon';
import { Spinner } from './display';

/**
 * Shared media viewer (lightbox) for chat, Drive, pages, mail, boards and vault attachments.
 * It grows out of the thumbnail that opened it over a dimmed backdrop; X, Esc or a click on
 * the backdrop close it; arrow keys move between items; the wheel zooms (around the pointer)
 * and dragging pans a zoomed image. Images load progressively: the thumbnail first (blurred
 * while small), the full image fades in over it.
 *
 * It only shows: URLs, downloads and links come from the caller, which also passes the texts
 * (this package has no dictionaries).
 */

export type ViewerKind = 'image' | 'video' | 'pdf' | 'other';

export interface ViewerItem {
  key: string;
  name: string;
  kind: ViewerKind;
  /** Full-size URL; null while it is being fetched. */
  src: string | null;
  /** A smaller image shown at once (the thumbnail that was on screen). */
  thumb?: string | null;
  /** Shown under the name, e.g. "2,4 MB". */
  meta?: string;
}

export interface ViewerLabels {
  close: string;
  prev: string;
  next: string;
  zoomIn: string;
  zoomOut: string;
  download: string;
  openInTab: string;
  copyLink: string;
  /** "3 / 7" */
  counter: (index: number, total: number) => string;
  /** Text for items that cannot be shown (archives, office files). */
  noPreview: string;
}

export interface MediaViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ViewerItem[];
  index: number;
  onIndexChange: (index: number) => void;
  /** Screen rect of the thumbnail that opened the viewer: the image grows out of it. */
  origin?: DOMRect | null;
  labels: ViewerLabels;
  onDownload?: (item: ViewerItem) => void;
  onOpenInTab?: (item: ViewerItem) => void;
  onCopyLink?: (item: ViewerItem) => void;
  /** The top bar (the desktop app lends its colours to the window buttons). */
  barRef?: Ref<HTMLDivElement>;
  /** Skip the grow and slide animations. */
  reducedMotion?: boolean;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

interface View {
  zoom: number;
  x: number;
  y: number;
}
const FIT: View = { zoom: 1, x: 0, y: 0 };

export function MediaViewer({
  open,
  onOpenChange,
  items,
  index,
  onIndexChange,
  origin,
  labels,
  onDownload,
  onOpenInTab,
  onCopyLink,
  barRef,
  reducedMotion,
}: MediaViewerProps) {
  const item = items[index];
  const total = items.length;
  const [view, setView] = useState<View>(FIT);
  const [shownKey, setShownKey] = useState(item?.key);
  // Another item: back to fit (adjusting state while rendering, not in an effect).
  if (item?.key !== shownKey) {
    setShownKey(item?.key);
    setView(FIT);
  }

  const go = useCallback(
    (step: number) => {
      if (total < 2) return;
      onIndexChange((index + step + total) % total);
    },
    [index, total, onIndexChange],
  );

  const zoomBy = useCallback((factor: number) => {
    setView((v) => clampView({ ...v, zoom: v.zoom * factor }));
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-') zoomBy(0.8);
    else if (e.key === '0') setView(FIT);
    else return;
    e.preventDefault();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] animate-fade-in bg-black/85 data-[state=closed]:animate-fade-out" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          data-desktop-overlay=""
          className="fixed inset-0 z-[70] flex flex-col text-white outline-none data-[state=closed]:animate-fade-out"
          style={{ top: 'var(--desktop-strip, 0px)' }}
        >
          <DialogPrimitive.Title className="sr-only">{item?.name ?? ''}</DialogPrimitive.Title>
          {/* Desktop app: the window buttons get this row, the close button stays under it. */}
          <div data-desktop-band="" data-titlebar-drag="" className="bg-black/40" />
          <div
            ref={barRef}
            data-titlebar-drag=""
            className="flex h-14 shrink-0 items-center gap-1 bg-black/40 pr-3 pl-5"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold">{item?.name}</span>
              <span className="truncate text-xs text-white/60">
                {[total > 1 ? labels.counter(index + 1, total) : null, item?.meta]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {item?.kind === 'image' ? (
              <>
                <BarButton icon="minus" label={labels.zoomOut} onClick={() => zoomBy(0.8)} />
                <span className="w-12 text-center text-xs text-white/70 tabular-nums">
                  {Math.round(view.zoom * 100)}%
                </span>
                <BarButton icon="plus" label={labels.zoomIn} onClick={() => zoomBy(1.25)} />
              </>
            ) : null}
            {onDownload && item ? (
              <BarButton icon="download" label={labels.download} onClick={() => onDownload(item)} />
            ) : null}
            {onOpenInTab && item?.src ? (
              <BarButton icon="ext" label={labels.openInTab} onClick={() => onOpenInTab(item)} />
            ) : null}
            {onCopyLink && item ? (
              <BarButton icon="link" label={labels.copyLink} onClick={() => onCopyLink(item)} />
            ) : null}
            <DialogPrimitive.Close asChild>
              <BarButton icon="x" label={labels.close} />
            </DialogPrimitive.Close>
          </div>
          <div
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
            onClick={(e) => {
              if (e.target === e.currentTarget) onOpenChange(false);
            }}
          >
            {item ? (
              <Stage
                key={item.key}
                item={item}
                view={view}
                setView={setView}
                origin={item.key === items[index]?.key ? origin : null}
                grow={!reducedMotion}
                noPreview={labels.noPreview}
                onBackdrop={() => onOpenChange(false)}
              />
            ) : null}
            {total > 1 ? (
              <>
                <SideButton side="left" label={labels.prev} onClick={() => go(-1)} />
                <SideButton side="right" label={labels.next} onClick={() => go(1)} />
              </>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The viewer's image alone (wheel zoom around the pointer, drag to pan, double click), for
 * previews that have their own frame (Drive's file preview).
 */
export function ZoomableImage({ src, name, thumb }: { src: string; name: string; thumb?: string }) {
  const [view, setView] = useState<View>(FIT);
  const frame = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  // Fits the frame it is in (not the window), and follows it when it resizes.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const read = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={frame} className="flex size-full items-center justify-center overflow-hidden">
      {area ? (
        <Stage
          item={{ key: src, name, kind: 'image', src, thumb }}
          view={view}
          setView={setView}
          origin={null}
          grow={false}
          noPreview=""
          area={area}
          onBackdrop={() => undefined}
        />
      ) : null}
    </div>
  );
}

function clampView(v: View): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
  return zoom === 1 ? FIT : { ...v, zoom };
}

/** The item itself: image (zoom and pan), video, PDF, or a "no preview" card. */
function Stage({
  item,
  view,
  setView,
  origin,
  grow,
  noPreview,
  area: frameArea,
  onBackdrop,
}: {
  item: ViewerItem;
  view: View;
  setView: (fn: (v: View) => View) => void;
  origin: DOMRect | null | undefined;
  grow: boolean;
  noPreview: string;
  /** Room for the picture; the window minus the bars when not given. */
  area?: { w: number; h: number };
  onBackdrop: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  const [sized, setSized] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number; real: boolean } | null>(null);
  const windowArea = useArea();
  const area = frameArea ?? windowArea;
  /** Aspect from whatever loaded first; the full image's own size caps the box later. */
  const noteSize = useCallback((img: HTMLImageElement, real: boolean) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    // Same size again (refs run on every commit): keep the state as it is.
    setDims((d) =>
      (d?.real && !real) || (d?.w === w && d.h === h && d.real === real) ? d : { w, h, real },
    );
    setSized(true);
  }, []);
  const thumbRef = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth) noteSize(img, false);
    },
    [noteSize],
  );
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const grown = useRef(false);

  // Grow out of the thumbnail once the box has its size (first image paint).
  useLayoutEffect(() => {
    const el = box.current;
    if (!(sized || item.kind !== 'image') || grown.current || !el) return;
    grown.current = true;
    if (!grow || !origin || typeof el.animate !== 'function') return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const sx = origin.width / to.width;
    const sy = origin.height / to.height;
    const dx = origin.left + origin.width / 2 - (to.left + to.width / 2);
    const dy = origin.top + origin.height / 2 - (to.top + to.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.6 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 280, easing: EASE },
    );
  }, [sized, grow, origin, item.kind]);

  const onWheel = (e: ReactWheelEvent) => {
    if (item.kind !== 'image') return;
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Zoom around the pointer: keep the point under it in place.
    const px = e.clientX - (r.left + r.width / 2);
    const py = e.clientY - (r.top + r.height / 2);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      if (zoom === 1) return FIT;
      const k = zoom / v.zoom;
      return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (view.zoom === 1 || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  if (item.kind === 'video' && item.src) {
    return (
      <div ref={box} className="flex max-h-full max-w-full p-6">
        <video
          src={item.src}
          poster={item.thumb ?? undefined}
          controls
          autoPlay
          className="max-h-[calc(100vh-120px)] max-w-full rounded-lg bg-black"
        />
      </div>
    );
  }
  if (item.kind === 'pdf' && item.src) {
    return (
      <div ref={box} className="flex size-full p-4 pt-2">
        <iframe src={item.src} title={item.name} className="size-full rounded-lg bg-white" />
      </div>
    );
  }
  if (item.kind === 'other') {
    return (
      <div
        ref={box}
        className="flex flex-col items-center gap-3 rounded-2xl bg-white/10 px-10 py-8 text-center"
      >
        <Icon name="file" size={40} />
        <span className="text-sm font-semibold">{item.name}</span>
        <span className="text-xs text-white/60">{noPreview}</span>
      </div>
    );
  }

  const shown = item.src ?? item.thumb;
  if (!shown) {
    return (
      <div className="flex size-full items-center justify-center" onClick={onBackdrop}>
        <Spinner className="border-white/20 border-t-white" />
      </div>
    );
  }
  const size = dims ? fitSize(dims, area) : null;
  return (
    <div
      ref={box}
      data-testid="viewer-image"
      className={cn(
        'relative shrink-0 touch-none select-none',
        view.zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
      )}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - (r.left + r.width / 2);
        const py = e.clientY - (r.top + r.height / 2);
        setView((v) => (v.zoom > 1 ? FIT : { zoom: 2.5, x: -px * 1.5, y: -py * 1.5 }));
      }}
      style={{
        width: size?.w,
        height: size?.h,
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        transition: dragging ? 'none' : 'transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      {/* The thumbnail shows at once (blurred while small); the full image fades in over it. */}
      {item.thumb ? (
        <img
          src={item.thumb}
          alt=""
          aria-hidden="true"
          draggable={false}
          onLoad={(e) => noteSize(e.currentTarget, false)}
          ref={thumbRef}
          className={cn(
            'absolute inset-0 size-full object-contain',
            item.src && fullLoaded ? 'opacity-0' : 'blur-[6px]',
          )}
        />
      ) : null}
      {item.src ? (
        <img
          src={item.src}
          alt={item.name}
          draggable={false}
          onLoad={(e) => {
            noteSize(e.currentTarget, true);
            setFullLoaded(true);
          }}
          className={cn(
            'absolute inset-0 size-full object-contain transition-opacity duration-300',
            fullLoaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : null}
    </div>
  );
}

/** Contain `d` in the area; never larger than the image itself once its real size is known. */
function fitSize(d: { w: number; h: number; real: boolean }, area: { w: number; h: number }) {
  const scale = Math.min(area.w / d.w, area.h / d.h, d.real ? 1 : Infinity);
  return { w: Math.round(d.w * scale), h: Math.round(d.h * scale) };
}

function useArea() {
  const read = () => ({
    w: Math.max(200, window.innerWidth - 160),
    h: Math.max(200, window.innerHeight - 120),
  });
  const [area, setArea] = useState(read);
  useEffect(() => {
    const on = () => setArea(read());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return area;
}

const BarButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }
>(function BarButton({ icon, label, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'press flex size-9 shrink-0 items-center justify-center rounded-full text-white/85 hover:bg-white/10 hover:text-white',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={18} />
    </button>
  );
});

function SideButton({
  side,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'press absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70',
        side === 'left' ? 'left-4' : 'right-4',
      )}
    >
      <Icon name={side === 'left' ? 'chevL' : 'chevR'} size={20} />
    </button>
  );
}
