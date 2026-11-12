import type { Editor, Extensions } from '@tiptap/core';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { EditorContent, useEditor } from '@tiptap/react';
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import type { Doc as YDoc } from 'yjs';
import type { EditorDoc, EmbedAttrs } from '../model';
import { createExtensions, type CollaborationOptions } from './extensions';
import {
  blockAtPos,
  blockAtSelection,
  canTurnInto,
  hasBlockRange,
  type BlockAt,
} from './extensions/blocks';
import { markdownToBlocks } from './extensions/paste';
import { filterSlashItems, SlashStore, type SlashItem } from './extensions/slash';
import type { EditorLabels } from './labels';
import { EditorUiContext, type EditorUi, type LinkPreview, type PickedVideo } from './ui/context';
import { BlockMenu } from './ui/BlockMenu';
import { FindBar, selectedSearchText } from './ui/FindBar';
import { GripIcon } from './ui/icons';
import { slashItems } from './ui/slash-items';
import { SlashMenu } from './ui/SlashMenu';
import { ImageToolbar, SelectionToolbar, TableToolbar } from './ui/Toolbars';
import { createNodeViews } from './ui/views';
import { UrlPopup } from './ui/UrlPrompt';
import { validateDoc } from './validate';
import { uploadAndInsert, type PasteOptions } from './extensions/paste';

export interface RichEditorHandle {
  getJSON(): EditorDoc;
  /** The Tiptap editor, for hosts that add their own extensions (decorations, anchors …). */
  getEditor(): Editor;
  /** Replaces the document (fires `onChange`). Throws when the doc does not fit the schema. */
  setContent(doc: EditorDoc): void;
  focus(): void;
  /** Parses markdown and inserts the blocks at the caret. */
  insertMarkdown(md: string): void;
}

export interface RichEditorProps {
  /** Initial content; the editor is uncontrolled afterwards. Remount (React key) to load another document. */
  value: EditorDoc;
  /** Called on every change with the new JSON (callers debounce/autosave). */
  onChange?: (doc: EditorDoc) => void;
  /** Default true. */
  editable?: boolean;
  /** All visible strings come from the host (i18n); the editor has no built-in UI text. */
  labels: EditorLabels;
  /** Shown in the empty block under the caret. */
  placeholder?: string;
  /** Maps a stored src such as `/media/img/a.png` to a URL the browser can load. */
  resolveImageUrl?: (src: string) => string;
  /** Uploads a picked/dropped/pasted image file; returns the src to store. */
  uploadImage?: (file: File) => Promise<{ src: string; alt?: string }>;
  /**
   * Uploads a picked/dropped/pasted file that is not an image; returns the node to embed. Also
   * offers "/" → File. Without it those files are ignored.
   */
  uploadFile?: (file: File) => Promise<{ nodeId: string; nodeType: string }>;
  /**
   * Lets the person choose a video from the host's files (the wiki's Drive) in an empty video
   * block; resolves null when they cancel. A file from the computer uploads through `uploadFile`.
   */
  pickVideo?: () => Promise<PickedVideo | null>;
  /**
   * Renders mermaid code to an SVG string for the live preview (e.g. a lazily imported
   * `mermaid.render` with `securityLevel: 'strict'`). Without it only the code is shown.
   */
  renderMermaid?: (code: string) => Promise<string>;
  /**
   * Wiki embeds (`::embed{node type}`): a preview of the embedded Hub node. Without it, or when
   * it returns null, the editor shows a plain card with the node type and id.
   */
  renderEmbed?: (attrs: EmbedAttrs) => ReactNode;
  /**
   * Title and icon of a web page for a new bookmark. It goes through the host's server, as a page
   * cannot read other sites. Without it the card shows the address.
   */
  previewLink?: (url: string) => Promise<LinkPreview>;
  /**
   * Text color and highlight in the selection toolbar. Only for hosts that store the document
   * itself: markdown does not keep colors.
   */
  textColor?: boolean;
  /**
   * Width and alignment of images (toolbar and drag handle). Only for hosts that store the
   * document itself: markdown does not keep them.
   */
  imageLayout?: boolean;
  /** Blog posts: allow the "summary limit" (truncate) block. */
  enableTruncate?: boolean;
  /**
   * `light`: small surfaces such as quick notes. The "/" menu offers only text blocks (text,
   * headings, lists, quote, code, divider) and the editor uses compact spacing (`ch-editor--light`).
   */
  variant?: 'full' | 'light';
  /**
   * Yjs-ready mode: the content lives in the Y.Doc (`value` is ignored) and undo/redo uses
   * the Yjs undo manager. See `CreateExtensionsOptions.collaboration`.
   */
  collaboration?: { doc: YDoc; field?: string } & Omit<CollaborationOptions, 'doc' | 'field'>;
  /**
   * Host extensions (suggestions, decorations …), added once at mount like the rest. They may
   * not add nodes or marks. See `CreateExtensionsOptions.extensions`.
   */
  extensions?: Extensions;
  /**
   * In-page find and replace: Ctrl+F / Ctrl+H anywhere on the screen open the find bar (the
   * browser's own find stays closed; the desktop app has none). For the screen's main editor.
   */
  find?: boolean;
  /** Extra "/" items after the built-in ones (e.g. the wiki's embed and sub-page). */
  slashItems?: (editor: Editor) => SlashItem[];
  /**
   * Extra buttons at the end of the selection toolbar (e.g. "Comment"). When the editor is
   * read-only and this is set, the toolbar still opens for a text selection with only these.
   */
  selectionActions?: (editor: Editor) => ReactNode;
  autofocus?: boolean;
  className?: string;
  /** Imperative handle. */
  editorRef?: Ref<RichEditorHandle>;
}

/**
 * Holds the latest props for the editor's callbacks: the Tiptap editor and its extensions are
 * created once, so callbacks, labels and options are read from here when they run.
 */
class HostBridge {
  props: RichEditorProps;
  pendingImagePos: number | null = null;
  /** "/" → "turn into"; set by the component, which owns the menu. */
  openTurnInto: ((editor: Editor) => void) | null = null;
  /** "/" → Image without uploads: the in-editor address field; set by the component. */
  openImageUrl: ((editor: Editor) => void) | null = null;
  readonly slash: SlashStore;
  readonly onUploadError: () => void;

  constructor(props: RichEditorProps, slash: SlashStore, onUploadError: () => void) {
    this.props = props;
    this.slash = slash;
    this.onUploadError = onUploadError;
  }

  update(props: RichEditorProps): void {
    this.props = props;
  }

  setOpenTurnInto(open: (editor: Editor) => void): void {
    this.openTurnInto = open;
  }

  setOpenImageUrl(open: (editor: Editor) => void): void {
    this.openImageUrl = open;
  }

  insertImage(editor: Editor, src: string, alt: string | null, pos: number | null): void {
    const node = { type: 'image', attrs: { src, alt, title: null } };
    const at = pos === null ? null : Math.min(pos, editor.state.doc.content.size);
    if (at === null) editor.chain().focus().insertContent(node).run();
    else editor.chain().focus().insertContentAt(at, node).run();
  }

  /**
   * "/" → Image: the file picker when uploads are possible, otherwise an address field in the
   * editor (the desktop app has no `window.prompt`).
   */
  pickImage(editor: Editor): void {
    const input = editor.view.dom
      .closest('.ch-editor')
      ?.querySelector<HTMLInputElement>(':scope > input[type="file"]');
    if (this.props.uploadImage && input) {
      this.pendingImagePos = editor.state.selection.from;
      input.click();
      return;
    }
    this.openImageUrl?.(editor);
  }

  /** A video file picked in an empty video block, uploaded like any attachment. */
  async uploadVideo(file: File): Promise<PickedVideo> {
    const up = this.props.uploadFile;
    if (!up) throw new Error('uploadFile is not set');
    const { nodeId } = await up(file);
    return { src: `node:${nodeId}`, title: file.name || null };
  }

  async pickVideo(): Promise<PickedVideo | null> {
    return (await this.props.pickVideo?.()) ?? null;
  }

  /** "/" → File: any file; images among them still land as images. */
  pickFile(editor: Editor): void {
    const input = editor.view.dom
      .closest('.ch-editor')
      ?.querySelector<HTMLInputElement>(':scope > input[data-ch-attach]');
    this.pendingImagePos = editor.state.selection.from;
    input?.click();
  }

  attachFiles(editor: Editor, files: File[]): void {
    const at = this.pendingImagePos;
    this.pendingImagePos = null;
    void uploadAndInsert(editor, files, at, this.uploadOptions());
  }

  /** The host's latest callbacks; the extensions are created once. */
  private uploadOptions(): PasteOptions {
    return {
      uploadImage: this.props.uploadImage
        ? (file) => {
            const up = this.props.uploadImage;
            return up ? up(file) : Promise.reject(new Error('uploadImage is not set'));
          }
        : undefined,
      uploadFile: this.props.uploadFile
        ? (file) => {
            const up = this.props.uploadFile;
            return up ? up(file) : Promise.reject(new Error('uploadFile is not set'));
          }
        : undefined,
      onUploadError: () => this.onUploadError(),
    };
  }

  async uploadFiles(editor: Editor, files: File[]): Promise<void> {
    const upload = this.props.uploadImage;
    let at = this.pendingImagePos;
    this.pendingImagePos = null;
    if (!upload) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const { src, alt } = await upload(file);
        if (editor.isDestroyed) return;
        this.insertImage(editor, src, alt ?? null, at);
        at = editor.state.selection.to;
      } catch {
        this.onUploadError();
      }
    }
  }

  extensions(): Extensions {
    const { collaboration, extensions } = this.props;
    return createExtensions({
      placeholder: () => this.props.placeholder ?? '',
      collaboration,
      extensions,
      resolveImageUrl: (src) => this.props.resolveImageUrl?.(src) ?? src,
      ...this.uploadOptions(),
      nodeViews: createNodeViews(),
      slash: {
        store: this.slash,
        getItems: (query, editor) =>
          filterSlashItems(
            [
              ...slashItems({
                labels: this.props.labels,
                enableTruncate: this.props.enableTruncate ?? false,
                pickImage: (e) => this.pickImage(e),
                pickFile: this.props.uploadFile ? (e) => this.pickFile(e) : undefined,
                openTurnInto: (e) => this.openTurnInto?.(e),
              }).filter((item) => this.props.variant !== 'light' || LIGHT_SLASH.has(item.id)),
              ...(this.props.slashItems?.(editor) ?? []),
            ],
            query,
          ),
      },
    });
  }
}

/**
 * Each list item has its own grip (H17): nested handles only inside lists; near an item's left
 * edge the outer item of a nested list is grabbed.
 */
const NESTED_HANDLES = { allowedContainers: ['bulletList', 'orderedList', 'taskList'] };

const LIGHT_SLASH = new Set([
  'text',
  'h1',
  'h2',
  'h3',
  'bulletList',
  'orderedList',
  'taskList',
  'quote',
  'codeBlock',
  'divider',
]);

/** Notion-like block editor for the portal and wiki document model. */
export function RichEditor(props: RichEditorProps): JSX.Element {
  const {
    value,
    editable = true,
    labels,
    renderMermaid,
    renderEmbed,
    previewLink,
    collaboration,
    autofocus = false,
    className,
    editorRef,
    selectionActions,
  } = props;

  const [uploadError, setUploadError] = useState(false);
  const [slashStore] = useState(() => new SlashStore());
  const [bridge] = useState(() => new HostBridge(props, slashStore, () => setUploadError(true)));
  useLayoutEffect(() => {
    bridge.update(props);
  });

  const [initial] = useState(() => ({
    value,
    validation: collaboration ? ({ ok: true } as const) : validateDoc(value),
  }));
  const valid = initial.validation.ok;
  const [extensions] = useState(() => bridge.extensions());
  const menuId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const editor = useEditor(
    {
      extensions,
      content: collaboration || !valid ? undefined : initial.value,
      editable: editable && valid,
      autofocus: autofocus ? 'end' : false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: 'ch-editor-content', spellcheck: 'true' },
      },
      onUpdate: ({ editor: e }) => {
        if (valid) bridge.props.onChange?.(e.getJSON() as EditorDoc);
      },
    },
    [],
  );

  useEffect(() => {
    if (editor.isEditable !== (editable && valid)) editor.setEditable(editable && valid);
  }, [editor, editable, valid]);

  useEffect(() => {
    if (!uploadError) return;
    const t = setTimeout(() => setUploadError(false), 5000);
    return () => clearTimeout(t);
  }, [uploadError]);

  useImperativeHandle(
    editorRef,
    (): RichEditorHandle => ({
      getJSON: () => editor.getJSON() as EditorDoc,
      getEditor: () => editor,
      setContent: (doc) => {
        const v = validateDoc(doc);
        if (!v.ok) throw new Error(`Invalid editor document: ${v.error}`);
        editor.commands.setContent(doc);
      },
      focus: () => {
        editor.commands.focus();
      },
      insertMarkdown: (md) => {
        const blocks = markdownToBlocks(md);
        if (blocks.length) editor.chain().focus().insertContent(blocks).run();
      },
    }),
    [editor],
  );

  const canUpload = Boolean(props.uploadFile);
  const canPickVideo = Boolean(props.pickVideo);
  const ui = useMemo<EditorUi>(
    () => ({
      labels,
      renderMermaid,
      renderEmbed,
      previewLink,
      resolveMediaUrl: props.resolveImageUrl,
      uploadVideo: canUpload ? (file) => bridge.uploadVideo(file) : undefined,
      pickVideo: canPickVideo ? () => bridge.pickVideo() : undefined,
      onUploadError: () => bridge.onUploadError(),
    }),
    [
      labels,
      renderMermaid,
      renderEmbed,
      previewLink,
      props.resolveImageUrl,
      canUpload,
      canPickVideo,
      bridge,
    ],
  );

  // The React DragHandle registers only the plugin (no lock commands); it reads this meta.
  const lockHandle = useCallback(
    (locked: boolean) => editor.view.dispatch(editor.state.tr.setMeta('lockDragHandle', locked)),
    [editor],
  );
  // The block under the drag handle (onNodeChange) and the open block menu.
  const handlePos = useRef<number | null>(null);
  const [blockMenu, setBlockMenu] = useState<{
    block: BlockAt;
    anchor: DOMRect;
    turnIntoOnly?: boolean;
  } | null>(null);
  const closeBlockMenu = useCallback(() => {
    setBlockMenu(null);
    if (editor.isDestroyed) return;
    lockHandle(false);
    editor.commands.focus();
  }, [editor, lockHandle]);
  const openBlockMenu = (grip: HTMLElement) => {
    const pos = handlePos.current;
    const block = pos === null ? null : blockAtPos(editor.state, pos);
    if (!block) return;
    lockHandle(true);
    setBlockMenu({ block, anchor: grip.getBoundingClientRect() });
  };

  // "Turn into" for what is selected: from the selection toolbar and the "/" menu.
  const openTurnInto = useCallback(
    (anchor: DOMRect) => {
      const block = blockAtSelection(editor.state);
      if (block && (hasBlockRange(editor.state) || canTurnInto(block))) {
        setBlockMenu({ block, anchor, turnIntoOnly: true });
      }
    },
    [editor],
  );
  useLayoutEffect(() => {
    bridge.setOpenTurnInto((e) => {
      let anchor: DOMRect;
      try {
        const at = e.view.coordsAtPos(e.state.selection.from);
        anchor = new DOMRect(at.left, at.top, 0, at.bottom - at.top);
      } catch {
        anchor = e.view.dom.getBoundingClientRect();
      }
      openTurnInto(anchor);
    });
  }, [bridge, openTurnInto]);

  // "/" → Image where nothing can be uploaded: an address field under the caret.
  const [imageUrl, setImageUrl] = useState<{ pos: number; anchor: DOMRect } | null>(null);
  useLayoutEffect(() => {
    bridge.setOpenImageUrl((e) => {
      const pos = e.state.selection.from;
      let anchor: DOMRect;
      try {
        const at = e.view.coordsAtPos(pos);
        anchor = new DOMRect(at.left, at.top, 0, at.bottom - at.top);
      } catch {
        anchor = e.view.dom.getBoundingClientRect();
      }
      setImageUrl({ pos, anchor });
    });
  }, [bridge]);
  const closeImageUrl = useCallback(() => {
    setImageUrl(null);
    if (!editor.isDestroyed) editor.commands.focus();
  }, [editor]);

  const [findOpen, setFindOpen] = useState<{
    replace: boolean;
    focusKey: number;
    initial: string;
  } | null>(null);
  const closeFind = useCallback(() => {
    setFindOpen(null);
    if (!editor.isDestroyed) editor.commands.focus();
  }, [editor]);
  const findEnabled = Boolean(props.find) && valid;
  useEffect(() => {
    if (!findEnabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // A Mac has ⌘F; ⌘H hides the app there, so replace is ⌘⌥F. Its Ctrl+F moves the caret.
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      if (!(mac ? e.metaKey : e.ctrlKey) || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const macReplace = mac && e.altKey && key === 'f';
      if (e.altKey && !macReplace) return;
      if (key !== 'f' && key !== 'h') return;
      // A dialog over the page has its own world.
      if ((e.target as Element | null)?.closest?.('[role="dialog"]')) return;
      e.preventDefault();
      setFindOpen((cur) => ({
        replace: key === 'h' || macReplace || Boolean(cur?.replace),
        focusKey: (cur?.focusKey ?? 0) + 1,
        initial: cur?.initial ?? selectedSearchText(editor),
      }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, findEnabled]);

  const isEditable = editable && valid;
  return (
    <EditorUiContext.Provider value={ui}>
      <div
        className={[
          'ch-editor',
          props.variant === 'light' && 'ch-editor--light',
          props.imageLayout && 'ch-editor--image-layout',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        data-editable={isEditable ? 'true' : 'false'}
      >
        {!valid ? (
          <div className="ch-editor-alert" role="alert">
            {labels.invalidContent}
          </div>
        ) : null}
        {uploadError ? (
          <div className="ch-editor-alert" role="status">
            {labels.imageUploadError}
          </div>
        ) : null}
        {isEditable ? (
          <DragHandle
            editor={editor}
            className="ch-drag-handle"
            nested={NESTED_HANDLES}
            onNodeChange={({ node, pos }) => {
              handlePos.current = node ? pos : null;
            }}
          >
            <button
              type="button"
              className="ch-drag-grip"
              aria-label={labels.dragHandle}
              aria-haspopup="menu"
              aria-expanded={blockMenu !== null}
              title={labels.dragHandle}
              tabIndex={-1}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => (blockMenu ? closeBlockMenu() : openBlockMenu(e.currentTarget))}
            >
              <GripIcon />
            </button>
          </DragHandle>
        ) : null}
        <EditorContent editor={editor} />
        {findOpen ? (
          <FindBar
            editor={editor}
            labels={labels}
            replace={findOpen.replace}
            focusKey={findOpen.focusKey}
            initial={findOpen.initial}
            onReplaceChange={(replace) => setFindOpen((cur) => (cur ? { ...cur, replace } : cur))}
            onClose={closeFind}
          />
        ) : null}
        {isEditable && blockMenu ? (
          <BlockMenu
            editor={editor}
            block={blockMenu.block}
            anchor={blockMenu.anchor}
            labels={labels}
            turnIntoOnly={blockMenu.turnIntoOnly}
            onClose={closeBlockMenu}
          />
        ) : null}
        {!isEditable && valid && selectionActions ? (
          <SelectionToolbar
            editor={editor}
            labels={labels}
            actions={selectionActions(editor)}
            actionsOnly
          />
        ) : null}
        {isEditable ? (
          <>
            <SelectionToolbar
              editor={editor}
              labels={labels}
              actions={selectionActions?.(editor)}
              onTurnInto={props.variant === 'light' ? undefined : openTurnInto}
              textColor={props.textColor}
            />
            <TableToolbar editor={editor} labels={labels} />
            {props.imageLayout ? <ImageToolbar editor={editor} labels={labels} /> : null}
            <SlashMenu store={slashStore} labels={labels} idPrefix={menuId} />
          </>
        ) : null}
        {isEditable && imageUrl ? (
          <UrlPopup
            anchor={imageUrl.anchor}
            placeholder={labels.imageUrlPrompt}
            onClose={closeImageUrl}
            onSubmit={(url) => {
              setImageUrl(null);
              bridge.insertImage(editor, url, null, imageUrl.pos);
            }}
          />
        ) : null}
        <input
          type="file"
          accept="image/*"
          multiple
          hidden
          tabIndex={-1}
          onChange={(e) => {
            void bridge.uploadFiles(editor, Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <input
          type="file"
          data-ch-attach=""
          multiple
          hidden
          tabIndex={-1}
          onChange={(e) => {
            bridge.attachFiles(editor, Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
    </EditorUiContext.Provider>
  );
}
