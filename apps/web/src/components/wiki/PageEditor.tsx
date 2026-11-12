import { emptyDoc, type EditorDoc } from '@crewhall/editor';
import {
  AssistHighlight,
  editorLabelKeys,
  RichEditor,
  type EditorLabels,
  type PickedVideo,
  type RichEditorHandle,
  type SlashItem,
} from '@crewhall/editor/react';
import '@crewhall/editor/styles.css';
import { PAGE_FRAGMENT, type CommentThread } from '@crewhall/shared';
import { Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import type { Editor, Range } from '@tiptap/core';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { useEditorAssist } from '@/components/ai/EditorAssist';
import { isVideoNode } from '@/features/drive/fileKinds';
import { NodePickerDialog } from '@/features/drive/NodePickerDialog';
import { uploadToFolder } from '@/lib/boards/upload';
import { enabledModules } from '@/lib/identity/modules';
import { useI18n, type I18nValue } from '@/lib/i18n/I18nContext';
import type { PageCollab } from '@/lib/wiki/collab';
import {
  CommentHighlights,
  scrollToAnchor,
  selectionAnchor,
  setCommentAnchors,
} from '@/lib/wiki/editor/comments';
import { MentionSuggest, PageLinkSuggest } from '@/lib/wiki/editor/suggest';
import { meQuery } from '@/lib/queries';
import { lazyFolder } from '@/lib/wiki/importPackage';
import { NodeLinks, resolveNodeSrc } from '@/lib/wiki/media';
import { api } from '@/lib/api';
import { renderMermaid } from '@/lib/wiki/mermaid';
import { EmbedPreview } from './EmbedPreview';
import { TableEmbed, TableEmbedDialog } from './TableEmbed';
import { insertPageLink, SuggestMenu, type EditorHost } from './SuggestMenu';
import './wiki.css';

const previewLink = (url: string) => api.call('previewLink', { body: { url } });

const THREAD_CLICK = 'wiki:thread-click';

export interface PageEditorHandle {
  editor: Editor | null;
  /** Anchor of the current selection for a new comment thread. */
  selectionAnchor: () => { start: string; end: string; quote: string } | null;
  scrollToThread: (t: CommentThread) => boolean;
  focus: () => void;
}

/**
 * The block editor's strings. The editor package has one set of labels for every host; they
 * live under `web.editor.<key>` (the editor i18n test checks each key).
 */
function editorLabels(t: I18nValue['t']): EditorLabels {
  return Object.fromEntries(
    editorLabelKeys.map((k) => [k, t(`editor.${k}`)]),
  ) as unknown as EditorLabels;
}

/**
 * The page body (design 5.1-5.8): `@crewhall/editor`'s block editor bound to the page's Yjs
 * doc (remote carets through the provider), with the wiki's "@" / "[[" menus, embeds, sub-pages
 * and comment highlights on top. Read-only for viewers and locked pages; text can still be
 * selected and commented there.
 */
export function PageEditor({
  collab,
  user,
  editable,
  host,
  threads,
  activeThread,
  onThreadClick,
  onComment,
  handleRef,
  initialContent,
  pageId,
  spaceId,
  onDoneCount,
  onEditor,
}: {
  collab: PageCollab | null;
  user: { id: string; name: string; color: string };
  editable: boolean;
  host: EditorHost;
  threads: CommentThread[];
  activeThread: string | null;
  onThreadClick: (id: string) => void;
  onComment: () => void;
  handleRef?: Ref<PageEditorHandle>;
  /** Local mode (no collab server): the body to show. */
  initialContent?: unknown;
  /** The page, as the source the AI writing help names (its access is checked server-side). */
  pageId?: string;
  /** Pasted and dropped files go to this space's Drive; without it they are not accepted. */
  spaceId?: string;
  /** How many to-dos of the body are completed, whenever it changes. */
  onDoneCount?: (count: number) => void;
  /** The live editor, for what sits beside the body (the outline). */
  onEditor?: (editor: Editor | null) => void;
}) {
  const { t } = useI18n();
  const labels = useMemo(() => editorLabels(t), [t]);
  const [picker, setPicker] = useState<((id: string, type: string) => void) | null>(null);
  const [tablePicker, setTablePicker] = useState<((id: string) => void) | null>(null);
  // An empty video block's "From Drive": the picker resolves the block's promise.
  const [videoPicker, setVideoPicker] = useState<((v: PickedVideo | null) => void) | null>(null);
  const pickVideo = () =>
    new Promise<PickedVideo | null>((resolve) => setVideoPicker(() => resolve));
  const me = useQuery(meQuery);
  const tablesOn = enabledModules(me.data).has('tables');
  const richRef = useRef<RichEditorHandle>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const local = !collab || collab.status === 'local';
  const imagesFolder = useMemo(
    () =>
      spaceId
        ? lazyFolder({
            spaceId,
            parentId: null,
            folderName: t('wiki.editor.imagesFolder'),
            system: 'page_images',
          })
        : null,
    [spaceId, t],
  );
  const attachmentsFolder = useMemo(
    () =>
      spaceId
        ? lazyFolder({
            spaceId,
            parentId: null,
            folderName: t('wiki.editor.attachmentsFolder'),
            system: 'page_attachments',
          })
        : null,
    [spaceId, t],
  );
  const uploadFile = async (file: File) => {
    const folderId = await attachmentsFolder!();
    const node = await uploadToFolder(file, {
      spaceId: spaceId!,
      folderId,
      name: file.name || 'file',
    });
    return { nodeId: node.id, nodeType: node.type };
  };
  const uploadImage = async (file: File) => {
    const folderId = await imagesFolder!();
    const node = await uploadToFolder(file, {
      spaceId: spaceId!,
      folderId,
      name: file.name || 'image.png',
    });
    return { src: `node:${node.id}` };
  };

  const [extensions] = useState(() => [
    MentionSuggest,
    PageLinkSuggest,
    NodeLinks,
    CommentHighlights((id) => window.dispatchEvent(new CustomEvent(THREAD_CLICK, { detail: id }))),
    AssistHighlight,
  ]);
  const assist = useEditorAssist({
    editor,
    editable,
    source: pageId ? { kind: 'node', nodeId: pageId } : { kind: 'draft' },
  });

  useEffect(() => {
    setEditor(richRef.current?.getEditor() ?? null);
  }, [collab?.doc, collab?.provider, local]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  useEffect(() => {
    if (!editor || !onDoneCount) return undefined;
    const report = () => {
      let done = 0;
      editor.state.doc.descendants((n) => {
        if (n.type.name === 'taskItem' && n.attrs.checked === true) done += 1;
        return true;
      });
      onDoneCount(done);
    };
    report();
    editor.on('update', report);
    return () => {
      editor.off('update', report);
    };
  }, [editor, onDoneCount]);

  useEffect(() => {
    const on = (e: Event) => onThreadClick((e as CustomEvent<string>).detail);
    window.addEventListener(THREAD_CLICK, on);
    return () => window.removeEventListener(THREAD_CLICK, on);
  }, [onThreadClick]);

  useEffect(() => {
    if (!editor) return;
    const anchors = threads
      .filter((x) => !x.resolvedAt && x.anchorStart && x.anchorEnd)
      .map((x) => ({ id: x.id, start: x.anchorStart!, end: x.anchorEnd! }));
    setCommentAnchors(editor, anchors, activeThread);
  }, [editor, threads, activeThread, collab?.status]);

  useImperativeHandle(
    handleRef,
    () => ({
      editor,
      selectionAnchor: () => (editor ? selectionAnchor(editor) : null),
      scrollToThread: (th) =>
        editor && th.anchorStart && th.anchorEnd
          ? scrollToAnchor(editor, { start: th.anchorStart, end: th.anchorEnd })
          : false,
      focus: () => editor?.commands.focus(),
    }),
    [editor],
  );

  const slashItems = (): SlashItem[] => [
    {
      id: 'embed',
      title: t('wiki.slash.embed'),
      description: t('wiki.slash.embedDesc'),
      keywords: ['embed', 'drive', 'file', 'board', 'drawing', 'göm', 'dosya', 'pano', 'çizim'],
      icon: 'embed',
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        setPicker(() => (nodeId: string, nodeType: string) => {
          e.chain().focus().insertContent({ type: 'embed', attrs: { nodeId, nodeType } }).run();
        });
      },
    },
    ...(spaceId && tablesOn
      ? [
          {
            id: 'tableEmbed',
            title: t('wiki.slash.tableEmbed'),
            description: t('wiki.slash.tableEmbedDesc'),
            keywords: [
              'table',
              'linked',
              'database',
              'db',
              'tablo',
              'tablolar',
              'bağlı',
              'veritabanı',
            ],
            icon: 'table',
            run: (e: Editor, r: Range) => {
              e.chain().focus().deleteRange(r).run();
              setTablePicker(() => (tableId: string) => {
                e.chain()
                  .focus()
                  .insertContent({ type: 'embed', attrs: { nodeId: tableId, nodeType: 'table' } })
                  .run();
              });
            },
          } satisfies SlashItem,
        ]
      : []),
    {
      id: 'subpage',
      title: t('wiki.slash.subpage'),
      description: t('wiki.slash.subpageDesc'),
      keywords: ['page', 'subpage', 'child', 'sayfa', 'alt'],
      icon: 'plus',
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        void host.createSubpage().then((p) => {
          if (p) insertPageLink(e, null, p);
        });
      },
    },
    {
      id: 'pageLink',
      title: t('wiki.slash.pageLink'),
      description: t('wiki.slash.pageLinkDesc'),
      keywords: ['link', '[[', 'page', 'sayfa', 'bağlantı'],
      icon: 'link',
      run: (e, r) => e.chain().focus().deleteRange(r).insertContent('[[').run(),
    },
    {
      id: 'toc',
      title: t('wiki.slash.toc'),
      description: t('wiki.slash.tocDesc'),
      keywords: [
        'toc',
        'contents',
        'outline',
        'içindekiler',
        'icindekiler',
        'başlıklar',
        'ana hat',
      ],
      icon: 'toc',
      run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'toc' }).run(),
    },
    ...assist.slashItems(),
  ];

  return (
    <div className="wk-editor relative" aria-label={t('wiki.editor.label')}>
      <RichEditor
        // A new doc / provider (or leaving local mode) needs a new editor.
        key={local ? 'local' : collabKey(collab)}
        value={local ? ((initialContent as EditorDoc | undefined) ?? emptyDoc()) : emptyDoc()}
        collaboration={
          local
            ? undefined
            : { doc: collab.doc, field: PAGE_FRAGMENT, provider: collab.provider, user }
        }
        editable={editable}
        find
        textColor
        imageLayout
        labels={labels}
        placeholder={t('wiki.editor.placeholder')}
        renderMermaid={renderMermaid}
        previewLink={previewLink}
        resolveImageUrl={resolveNodeSrc}
        uploadImage={imagesFolder ? uploadImage : undefined}
        uploadFile={attachmentsFolder ? uploadFile : undefined}
        pickVideo={pickVideo}
        renderEmbed={(attrs) =>
          !attrs.nodeId ? null : attrs.nodeType === 'table' ? (
            <TableEmbed tableId={attrs.nodeId} />
          ) : (
            <EmbedPreview attrs={attrs} />
          )
        }
        extensions={extensions}
        slashItems={slashItems}
        selectionActions={() => (
          <>
            {assist.button}
            <button
              type="button"
              className="ch-tool wk-comment-tool"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onComment}
            >
              <Icon name="comment" size={16} /> {t('wiki.editor.comment')}
            </button>
          </>
        )}
        editorRef={richRef}
      />
      {editable ? <SuggestMenu host={host} /> : null}
      {assist.panel}
      {spaceId ? (
        <TableEmbedDialog
          spaceId={spaceId}
          open={tablePicker !== null}
          onClose={() => setTablePicker(null)}
          onPick={(id) => {
            tablePicker?.(id);
            setTablePicker(null);
          }}
        />
      ) : null}
      <NodePickerDialog
        open={picker !== null}
        title={t('wiki.editor.embedPick')}
        confirm={t('wiki.editor.embedInsert')}
        onClose={() => setPicker(null)}
        onPick={(n) => {
          picker?.(n.id, n.type);
          setPicker(null);
        }}
      />
      <NodePickerDialog
        open={videoPicker !== null}
        title={t('wiki.editor.videoPick')}
        confirm={t('wiki.editor.embedInsert')}
        accept={isVideoNode}
        onClose={() => {
          videoPicker?.(null);
          setVideoPicker(null);
        }}
        onPick={(n) => {
          videoPicker?.({ src: `node:${n.id}`, title: n.name });
          setVideoPicker(null);
        }}
      />
    </div>
  );
}

const docIds = new WeakMap<object, number>();
let nextDocId = 1;

/** A stable number per (Y.Doc, provider) pair, for the editor's React key. */
function collabKey(c: PageCollab): string {
  const id = (o: object | null) => {
    if (!o) return 0;
    let n = docIds.get(o);
    if (n === undefined) {
      n = nextDocId++;
      docIds.set(o, n);
    }
    return n;
  };
  return `${id(c.doc)}:${id(c.provider)}`;
}
