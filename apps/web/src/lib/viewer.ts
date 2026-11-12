import { type ViewerKind } from '@crewhall/ui';
import { useSyncExternalStore } from 'react';

/**
 * Opens the shared media viewer (ViewerHost, mounted once in the shell) from anywhere: chat,
 * Drive, pages, mail, boards, vault. Our own files stay in the app (no new tab), which also
 * keeps the desktop app from sending them to the browser.
 */

export interface ViewerSource {
  key: string;
  name: string;
  mime: string | null;
  sizeBytes?: number;
  /** Full-size URL to show inline (fetched when the item comes on screen). */
  url: () => Promise<string>;
  /** A thumbnail already on screen: shown at once, blurred until the full image is in. */
  thumb?: string | null;
  /** Download URL (Content-Disposition: attachment); defaults to the inline URL. */
  download?: () => Promise<string>;
  /** In-app path for "Linki kopyala" (e.g. the message or the Drive file). */
  link?: string;
  /** Decrypted in memory (vault): no "open in new tab" or link, the blob URL dies on close. */
  private?: boolean;
}

/**
 * Signed download URLs may carry `Content-Disposition: attachment`, which makes an iframe
 * download the PDF instead of showing it; fetching it and framing a blob URL always works.
 */
export async function asBlobUrl(url: string, type: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
}

export interface ViewerState {
  items: ViewerSource[];
  index: number;
  origin: DOMRect | null;
}

let state: ViewerState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const BY_EXTENSION: [RegExp, ViewerKind][] = [
  [/\.(png|jpe?g|gif|webp|avif|bmp)$/i, 'image'],
  [/\.(mp4|webm|mov|m4v|ogv)$/i, 'video'],
  [/\.pdf$/i, 'pdf'],
];

export function kindOf(mime: string | null | undefined, name = ''): ViewerKind {
  const m = mime ?? '';
  if (m === 'image/svg+xml') return 'other';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  // No type, or a generic one (a file handed over by the desktop app): go by the name.
  if (!m || m === 'application/octet-stream') {
    return BY_EXTENSION.find(([re]) => re.test(name))?.[1] ?? 'other';
  }
  return 'other';
}

/** What the viewer can show in place; anything else is downloaded as before. */
export function canView(mime: string | null | undefined, name = ''): boolean {
  return kindOf(mime, name) !== 'other';
}

/**
 * `from` is the thumbnail that was clicked: the image grows out of it. Items it cannot show
 * are left out, so arrows only move between viewable files.
 */
export function openViewer(
  items: ViewerSource[],
  index = 0,
  from?: Element | DOMRect | null,
): void {
  const picked = items[index];
  const list = items.filter((i) => canView(i.mime, i.name));
  if (!picked || !list.length) return;
  const at = Math.max(0, list.indexOf(picked));
  const origin = from instanceof Element ? from.getBoundingClientRect() : (from ?? null);
  state = { items: list, index: at, origin };
  emit();
}

export function setViewerIndex(index: number): void {
  if (!state) return;
  // The grow is only for the first item; moving on just swaps the picture.
  state = { ...state, index, origin: null };
  emit();
}

export function closeViewer(): void {
  state = null;
  emit();
}

export function useViewer(): ViewerState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => null,
  );
}
