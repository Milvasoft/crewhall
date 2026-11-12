import type { TemplateKind } from '@crewhall/shared';
import { useSyncExternalStore } from 'react';

/** Wiki dialogs, opened from the sidebar, the page menu and the empty-page shortcuts. */
export type WikiDialog =
  | {
      kind: 'templates';
      spaceId: string;
      parentId: string | null;
      templateKind?: TemplateKind | 'all';
    }
  | { kind: 'import'; spaceId: string; parentId: string | null }
  | {
      kind: 'saveTemplate';
      templateKind: TemplateKind;
      /** The page or board; none for a space. */
      nodeId?: string;
      spaceId: string;
      name: string;
    }
  | { kind: 'export'; nodeId: string; name: string }
  /** "Portal'a gönder": the page becomes a draft portal doc. */
  | { kind: 'toPortal'; nodeId: string; name: string }
  | null;

let dialog: WikiDialog = null;
const listeners = new Set<() => void>();

export function openWikiDialog(d: WikiDialog): void {
  dialog = d;
  listeners.forEach((l) => l());
}

export function useWikiDialog(): WikiDialog {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => dialog,
    () => null,
  );
}
