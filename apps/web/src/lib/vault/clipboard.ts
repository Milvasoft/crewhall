import { useSyncExternalStore } from 'react';

/**
 * Copy with auto-clear (design 8.6): after N seconds the clipboard is emptied, but only when it
 * still holds what we wrote. If the browser does not let us read it back, we clear anyway:
 * leaving a secret behind is worse than wiping something else.
 */

interface CopyState {
  /** i18n label of what was copied ("Şifre"), for the toast. */
  label: string | null;
  clearsAt: number | null;
}

let state: CopyState = { label: null, clearsAt: null };
let timer: ReturnType<typeof setTimeout> | null = null;
let written: string | null = null;
const listeners = new Set<() => void>();

function emit(next: CopyState) {
  state = next;
  listeners.forEach((l) => l());
}

export function useCopyState(): CopyState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

async function writeText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Permission denied (embedded views, some browsers): fall through.
    }
  }
  // Fallback for insecure contexts (LAN IP over http in development) and denied permission.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.value = '';
  area.remove();
  if (!ok && text) throw new Error('copy_failed');
}

export async function clearClipboard() {
  if (timer) clearTimeout(timer);
  timer = null;
  const ours = written;
  written = null;
  emit({ label: null, clearsAt: null });
  if (ours === null) return;
  try {
    const current = await navigator.clipboard.readText();
    if (current !== ours) return;
  } catch {
    // Cannot read it back (permission): clear anyway.
  }
  await writeText('').catch(() => undefined);
}

export async function copySecret(text: string, label: string, seconds: number) {
  await writeText(text);
  written = text;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void clearClipboard(), seconds * 1000);
  emit({ label, clearsAt: Date.now() + seconds * 1000 });
}

/** Hides the toast without touching the clipboard (the timer keeps running). */
export function dismissCopyToast() {
  emit({ ...state, label: null });
}
