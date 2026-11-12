import type { ThemedImage } from '@/components/home/Home';

/** An image with an optional dark-mode variant. */
export function Img({
  image,
  alt,
  className,
  eager,
}: {
  image: ThemedImage | null;
  alt: string;
  className?: string | undefined;
  eager?: boolean;
}) {
  if (!image) return null;
  const loading = eager ? 'eager' : 'lazy';
  if (!image.dark) {
    return (
      <img src={image.src} alt={alt} className={className} loading={loading} decoding="async" />
    );
  }
  return (
    <>
      <img
        src={image.src}
        alt={alt}
        className={`${className ?? ''} themed-light`}
        loading={loading}
        decoding="async"
      />
      <img
        src={image.dark}
        alt={alt}
        className={`${className ?? ''} themed-dark`}
        loading={loading}
        decoding="async"
      />
    </>
  );
}

export function YouTube({
  video,
  className,
}: {
  video: { id: string; title: string };
  className?: string;
}) {
  return (
    <iframe
      className={className}
      src={`https://www.youtube.com/embed/${encodeURIComponent(video.id)}`}
      title={video.title}
      loading="lazy"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      referrerPolicy="strict-origin-when-cross-origin"
      allowFullScreen
    />
  );
}

/** A CSS url() value for a media path (used as a mask). */
export const cssUrl = (src: string) => `url(${JSON.stringify(src)})`;

/** Offset of `el` inside `ancestor` from the layout (transforms are ignored). */
export function layoutBox(el: HTMLElement, ancestor: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}
