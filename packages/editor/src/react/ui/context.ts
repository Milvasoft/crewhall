import type { Editor } from '@tiptap/core';
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { EmbedAttrs } from '../../model';
import type { EditorLabels } from '../labels';

export interface EditorUi {
  labels: EditorLabels;
  renderMermaid?: (code: string) => Promise<string>;
  renderEmbed?: (attrs: EmbedAttrs) => ReactNode;
  previewLink?: (url: string) => Promise<LinkPreview>;
  resolveMediaUrl?: (src: string) => string;
  /** Uploads a video picked in an empty video block; absent where files cannot be uploaded. */
  uploadVideo?: (file: File) => Promise<PickedVideo>;
  /** Lets the person choose a video from the host's files (Drive); null when they cancel. */
  pickVideo?: () => Promise<PickedVideo | null>;
  /** A failed upload, shown by the editor. */
  onUploadError?: () => void;
}

/** A video file for the video block: `src` as stored (e.g. `node:<id>`). */
export interface PickedVideo {
  src: string;
  title: string | null;
}

export interface LinkPreview {
  title: string | null;
  faviconUrl: string | null;
  /** The page's summary; hosts whose server does not read it leave it out. */
  description?: string | null;
  /** Its preview image (an http(s) address). */
  imageUrl?: string | null;
}

/** Host settings for node views (they render inside <EditorContent>, so context reaches them). */
export const EditorUiContext = createContext<EditorUi | null>(null);

export function useEditorUi(): EditorUi {
  const ui = useContext(EditorUiContext);
  if (!ui) throw new Error('Editor node views must render inside <RichEditor>');
  return ui;
}

/** Re-renders when `editor.setEditable` changes the mode. */
export function useIsEditable(editor: Editor): boolean {
  return useSyncExternalStore(
    (cb) => {
      editor.on('update', cb);
      editor.on('transaction', cb);
      return () => {
        editor.off('update', cb);
        editor.off('transaction', cb);
      };
    },
    () => editor.isEditable,
    () => editor.isEditable,
  );
}
