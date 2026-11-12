import {
  editorLabelKeys,
  RichEditor,
  type EditorLabels,
  type RichEditorHandle,
} from '@crewhall/editor/react';
import '@crewhall/editor/styles.css';
import { type PortalRichDoc } from '@crewhall/shared';
import { useMemo, useRef, type Ref } from 'react';
import { useI18n, type I18nValue } from '@/lib/i18n/I18nContext';
import { hubMediaUrl, uploadPortalFile } from '@/lib/portal/media';

/**
 * The only place that renders `@crewhall/editor/react` (the Tiptap block editor). Screens pass
 * the draft JSON and get changes back; every label comes from `web.editor.<key>` for
 * each key of the package's `editorLabelKeys` (the editor i18n test checks them all).
 */

export function editorLabels(t: I18nValue['t']): EditorLabels {
  return Object.fromEntries(
    editorLabelKeys.map((k) => [k, t(`editor.${k}`)]),
  ) as unknown as EditorLabels;
}

export function PortalEditor({
  siteId,
  value,
  onChange,
  editable = true,
  placeholder,
  enableTruncate,
  editorRef,
  className,
}: {
  siteId: string;
  value: PortalRichDoc;
  onChange?: (json: PortalRichDoc) => void;
  editable?: boolean;
  placeholder?: string;
  enableTruncate?: boolean;
  editorRef?: Ref<RichEditorHandle>;
  className?: string;
}) {
  const { t } = useI18n();
  const labels = useMemo(() => editorLabels(t), [t]);
  // The editor may normalize a loaded doc (trailing paragraph) and report it as a change;
  // only edits after the person touched the editor count, so opening a doc never dirties it.
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
  };
  return (
    <div
      className={className}
      data-testid="portal-editor"
      onKeyDownCapture={touch}
      onPointerDownCapture={touch}
      onPasteCapture={touch}
      onDropCapture={touch}
      onInputCapture={touch}
    >
      <RichEditor
        value={value}
        onChange={
          onChange
            ? (doc) => {
                if (touched.current) onChange(doc as PortalRichDoc);
              }
            : undefined
        }
        editable={editable}
        labels={labels}
        placeholder={placeholder ?? t('editor.placeholder')}
        resolveImageUrl={(src) => hubMediaUrl(siteId, src)}
        uploadImage={async (file) => {
          const media = await uploadPortalFile(siteId, file, 'uploads');
          return { src: media.path };
        }}
        enableTruncate={enableTruncate}
        editorRef={editorRef}
      />
    </div>
  );
}
