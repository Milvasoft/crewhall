import type { NodeViewRenderer } from '@tiptap/core';
import type Katex from 'katex';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { useEffect, useId, useRef, useState, type JSX } from 'react';
import {
  isAdmonitionType,
  videoSource,
  webUrl,
  type AdmonitionType,
  type EmbedAttrs,
} from '../../model';
import { outlineDepth, scrollToHeading, useOutline } from '../outline';
import type { ViewNodeName } from '../extensions';
import type { EditorLabels } from '../labels';
import { useEditorUi, useIsEditable, type PickedVideo } from './context';
import { Icon } from './icons';
import { UrlPrompt } from './UrlPrompt';

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export const admonitionLabelKey: Record<AdmonitionType, keyof EditorLabels> = {
  note: 'admonitionNote',
  tip: 'admonitionTip',
  info: 'admonitionInfo',
  warning: 'admonitionWarning',
  danger: 'admonitionDanger',
  caution: 'admonitionCaution',
  important: 'admonitionImportant',
  success: 'admonitionSuccess',
  secondary: 'admonitionSecondary',
};

/** Types offered in the picker; the others stay selectable when a document already uses them. */
const PICKER_TYPES: readonly AdmonitionType[] = [
  'note',
  'tip',
  'info',
  'warning',
  'danger',
  'caution',
];

const ADMONITION_ICON: Record<AdmonitionType, string> = {
  note: 'note',
  tip: 'tip',
  info: 'info',
  warning: 'warning',
  danger: 'danger',
  caution: 'warning',
  important: 'info',
  success: 'check',
  secondary: 'note',
};

function AdmonitionView({ node, editor, updateAttributes }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  const editable = useIsEditable(editor);
  const raw = String(node.attrs.type);
  const type: AdmonitionType = isAdmonitionType(raw) ? raw : 'note';
  const title = str(node.attrs.title) ?? '';
  const options = PICKER_TYPES.includes(type) ? PICKER_TYPES : [...PICKER_TYPES, type];
  return (
    <NodeViewWrapper className={`ch-admonition ch-admonition-${type}`} data-admonition-type={type}>
      <div className="ch-admonition-head" contentEditable={false}>
        <span className="ch-admonition-icon">
          <Icon name={ADMONITION_ICON[type]} />
        </span>
        <select
          className="ch-admonition-type"
          aria-label={labels.admonitionType}
          value={type}
          disabled={!editable}
          onChange={(e) => updateAttributes({ type: e.target.value })}
        >
          {options.map((t) => (
            <option key={t} value={t}>
              {labels[admonitionLabelKey[t]]}
            </option>
          ))}
        </select>
        <input
          className="ch-admonition-title"
          value={title}
          placeholder={labels.admonitionTitlePlaceholder}
          aria-label={labels.admonitionTitlePlaceholder}
          readOnly={!editable}
          onChange={(e) => updateAttributes({ title: e.target.value || null })}
        />
      </div>
      <NodeViewContent className="ch-admonition-body" />
    </NodeViewWrapper>
  );
}

interface TabInfo {
  value: string;
  label: string;
  isDefault: boolean;
}

function TabsView({ node, editor, getPos }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  const editable = useIsEditable(editor);
  const cssId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const tabs: TabInfo[] = [];
  node.forEach((child) => {
    const value = String(child.attrs.value ?? '');
    tabs.push({
      value,
      label: str(child.attrs.label) ?? value,
      isDefault: child.attrs.default === true,
    });
  });
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      tabs.findIndex((t) => t.isDefault),
    ),
  );
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const current = Math.min(active, tabs.length - 1);

  /** The tabs node as it is in the document now (render-time props can lag behind). */
  const live = (): { pos: number; node: PMNode } | null => {
    const pos = getPos();
    if (typeof pos !== 'number') return null;
    const current = editor.state.doc.nodeAt(pos);
    return current && current.type.name === 'tabs' ? { pos, node: current } : null;
  };

  /** Document position of the i-th tab item. */
  const tabPos = (index: number): number | null => {
    const l = live();
    if (!l) return null;
    let p = l.pos + 1;
    for (let i = 0; i < index && i < l.node.childCount; i++) p += l.node.child(i).nodeSize;
    return p;
  };

  // Follow the caret: moving into a hidden tab (keyboard, search) shows it.
  useEffect(() => {
    const onSelection = () => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      const { from } = editor.state.selection;
      const tabsNode = editor.state.doc.nodeAt(pos);
      if (!tabsNode || from <= pos || from >= pos + tabsNode.nodeSize) return;
      let p = pos + 1;
      for (let i = 0; i < tabsNode.childCount; i++) {
        const size = tabsNode.child(i).nodeSize;
        if (from > p && from < p + size) {
          setActive(i);
          return;
        }
        p += size;
      }
    };
    editor.on('selectionUpdate', onSelection);
    return () => {
      editor.off('selectionUpdate', onSelection);
    };
  }, [editor, getPos]);

  const select = (index: number) => {
    setActive(index);
    const p = tabPos(index);
    if (p === null || !editable) return;
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .command(({ tr }) => {
        tr.setSelection(Selection.near(tr.doc.resolve(p + 1)));
        return true;
      })
      .run();
  };

  const add = () => {
    const l = live();
    if (!l) return;
    const used = new Set<string>();
    l.node.forEach((child) => used.add(String(child.attrs.value)));
    let n = l.node.childCount + 1;
    while (used.has(`tab${n}`)) n++;
    editor
      .chain()
      .insertContentAt(l.pos + l.node.nodeSize - 1, {
        type: 'tabItem',
        attrs: { value: `tab${n}`, label: `${labels.tabsNewTab} ${n}`, default: false },
        content: [{ type: 'paragraph' }],
      })
      .run();
    select(l.node.childCount);
  };

  const remove = (index: number) => {
    const l = live();
    const p = tabPos(index);
    if (!l || p === null) return;
    editor
      .chain()
      .command(({ tr }) => {
        if (l.node.childCount <= 1) tr.delete(l.pos, l.pos + l.node.nodeSize);
        else tr.delete(p, p + l.node.child(index).nodeSize);
        return true;
      })
      .run();
    setActive(Math.max(0, index - 1));
  };

  const rename = (index: number, label: string) => {
    const p = tabPos(index);
    setRenaming(null);
    if (p === null) return;
    editor
      .chain()
      .command(({ tr }) => {
        const child = tr.doc.nodeAt(p);
        if (!child) return false;
        tr.setNodeMarkup(p, undefined, { ...child.attrs, label: label.trim() || null });
        return true;
      })
      .run();
  };

  const toggleDefault = (index: number) => {
    const l = live();
    if (!l) return;
    const makeDefault = l.node.maybeChild(index)?.attrs.default !== true;
    editor
      .chain()
      .command(({ tr }) => {
        let p = l.pos + 1;
        l.node.forEach((child, _offset, i) => {
          const value = makeDefault && i === index;
          if (child.attrs.default !== value) {
            tr.setNodeMarkup(p, undefined, { ...child.attrs, default: value });
          }
          p += child.nodeSize;
        });
        return true;
      })
      .run();
  };

  const startRename = (index: number) => {
    if (!editable) return;
    setDraft(tabs[index]?.label ?? '');
    setRenaming(index);
  };

  const hideOthers =
    `[data-ch-tabs="${cssId}"]>[data-node-view-content]>[data-node-view-content-react]>` +
    `:not(:nth-child(${current + 1})){display:none}`;

  return (
    <NodeViewWrapper className="ch-tabs" data-ch-tabs={cssId}>
      <div className="ch-tabs-head" contentEditable={false}>
        <style>{hideOthers}</style>
        <div className="ch-tabs-list" role="tablist" aria-label={labels.tabsLabel}>
          {tabs.map((tab, i) =>
            renaming === i ? (
              <input
                key={`${tab.value}-${i}`}
                className="ch-tabs-rename"
                value={draft}
                autoFocus
                placeholder={labels.tabsLabelPlaceholder}
                aria-label={labels.tabsLabelPlaceholder}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => rename(i, draft)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    rename(i, draft);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(null);
                  }
                }}
              />
            ) : (
              <button
                key={`${tab.value}-${i}`}
                type="button"
                role="tab"
                aria-selected={i === current}
                className="ch-tabs-tab"
                onClick={() => select(i)}
                onDoubleClick={() => startRename(i)}
              >
                {tab.label}
                {tab.isDefault ? (
                  <span className="ch-tabs-default" title={labels.tabsDefault}>
                    <Icon name="star" size={12} />
                  </span>
                ) : null}
              </button>
            ),
          )}
        </div>
        {editable ? (
          <div className="ch-tabs-actions">
            <button
              type="button"
              className="ch-icon-btn"
              title={labels.tabsAdd}
              aria-label={labels.tabsAdd}
              onClick={add}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              className="ch-icon-btn"
              title={labels.tabsRename}
              aria-label={labels.tabsRename}
              onClick={() => startRename(current)}
            >
              <Icon name="pencil" size={14} />
            </button>
            <button
              type="button"
              className="ch-icon-btn"
              title={labels.tabsSetDefault}
              aria-label={labels.tabsSetDefault}
              aria-pressed={tabs[current]?.isDefault === true}
              onClick={() => toggleDefault(current)}
            >
              <Icon name="star" size={14} />
            </button>
            <button
              type="button"
              className="ch-icon-btn"
              title={labels.tabsRemove}
              aria-label={labels.tabsRemove}
              onClick={() => remove(current)}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ) : null}
      </div>
      <NodeViewContent className="ch-tabs-body" />
    </NodeViewWrapper>
  );
}

function MermaidView({ node }: ReactNodeViewProps): JSX.Element {
  const { labels, renderMermaid } = useEditorUi();
  const code = node.textContent;
  const [preview, setPreview] = useState<{ code: string; svg: string | null; error: boolean }>({
    code: '',
    svg: null,
    error: false,
  });

  useEffect(() => {
    if (!renderMermaid || !code.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      renderMermaid(code).then(
        (svg) => {
          if (!cancelled) setPreview({ code, svg, error: false });
        },
        () => {
          if (!cancelled) setPreview({ code, svg: null, error: true });
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, renderMermaid]);

  const showPreview = Boolean(renderMermaid && code.trim());
  return (
    <NodeViewWrapper className="ch-mermaid">
      <div className="ch-block-head" contentEditable={false}>
        <Icon name="mermaid" size={14} />
        <span>{labels.mermaidLabel}</span>
      </div>
      <pre className="ch-mermaid-code" spellCheck={false}>
        <NodeViewContent<'code'> as="code" />
      </pre>
      {showPreview ? (
        <div className="ch-mermaid-preview" contentEditable={false}>
          {preview.error ? (
            <div className="ch-mermaid-error" role="status">
              {labels.mermaidPreviewError}
            </div>
          ) : preview.svg !== null ? (
            // The SVG comes from the host's mermaid renderer (securityLevel "strict"), not from
            // the document; raw HTML blocks are never injected.
            <div className="ch-mermaid-svg" dangerouslySetInnerHTML={{ __html: preview.svg }} />
          ) : null}
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

function CodeBlockView({ node, editor, updateAttributes }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  const editable = useIsEditable(editor);
  const language = str(node.attrs.language) ?? '';
  const title = str(node.attrs.title) ?? '';
  return (
    <NodeViewWrapper className="ch-code">
      <div className="ch-code-head" contentEditable={false}>
        <input
          className="ch-code-lang"
          value={language}
          placeholder={labels.codeLanguagePlaceholder}
          aria-label={labels.codeLanguagePlaceholder}
          readOnly={!editable}
          spellCheck={false}
          onChange={(e) => updateAttributes({ language: e.target.value.trim() || null })}
        />
        {editable ? (
          <input
            className="ch-code-title"
            value={title}
            placeholder={labels.codeTitlePlaceholder}
            aria-label={labels.codeTitlePlaceholder}
            spellCheck={false}
            onChange={(e) => updateAttributes({ title: e.target.value || null })}
          />
        ) : title ? (
          // Read-only: the file name is plain text, and an empty one shows nothing.
          <span className="ch-code-title">{title}</span>
        ) : null}
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<'code'>
          as="code"
          className={language ? `hljs language-${language}` : 'hljs'}
        />
      </pre>
    </NodeViewWrapper>
  );
}

function TruncateView({ selected }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  return (
    <NodeViewWrapper
      className={`ch-truncate${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      data-drag-handle=""
    >
      <span className="ch-truncate-label">
        <Icon name="truncate" size={14} />
        {labels.truncateLabel}
      </span>
    </NodeViewWrapper>
  );
}

function TocView({ editor, selected }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  const items = useOutline(editor);
  return (
    <NodeViewWrapper
      className={`ch-toc${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      data-drag-handle=""
    >
      <nav aria-label={labels.tocTitle}>
        <p className="ch-toc-title">{labels.tocTitle}</p>
        {items.length ? (
          <ul>
            {items.map((item) => (
              <li key={item.pos}>
                <button
                  type="button"
                  style={{ paddingLeft: `${outlineDepth(items, item) * 16}px` }}
                  onClick={() => scrollToHeading(editor, item.pos)}
                >
                  {item.text}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ch-toc-empty">{labels.tocEmpty}</p>
        )}
      </nav>
    </NodeViewWrapper>
  );
}

function UnknownBlockView({ selected }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  return (
    <NodeViewWrapper
      className={`ch-unknown${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      role="note"
    >
      <Icon name="info" size={14} />
      {labels.unknownBlock}
    </NodeViewWrapper>
  );
}

function HtmlBlockView({
  node,
  editor,
  selected,
  updateAttributes,
}: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  const editable = useIsEditable(editor);
  const html = String(node.attrs.html ?? '');
  const [editing, setEditing] = useState(html === '');
  const [draft, setDraft] = useState(html);
  const commit = () => {
    if (draft !== html) updateAttributes({ html: draft });
    setEditing(false);
  };
  return (
    <NodeViewWrapper
      className={`ch-html-block${selected ? ' is-selected' : ''}`}
      contentEditable={false}
    >
      <div className="ch-block-head">
        <Icon name="html" size={14} />
        <span>{labels.htmlBlockLabel}</span>
        {editable ? (
          <button
            type="button"
            className="ch-text-btn"
            onClick={() => {
              if (editing) commit();
              else {
                setDraft(html);
                setEditing(true);
              }
            }}
          >
            {editing ? labels.htmlDone : labels.htmlEdit}
          </button>
        ) : null}
      </div>
      {editing && editable ? (
        <textarea
          className="ch-html-textarea"
          value={draft}
          spellCheck={false}
          aria-label={labels.htmlBlockLabel}
          rows={Math.min(16, Math.max(3, draft.split('\n').length + 1))}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        // React escapes the text: the HTML is shown, never rendered.
        <pre className="ch-html-source">{html}</pre>
      )}
    </NodeViewWrapper>
  );
}

function HtmlInlineView({ node, selected }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  return (
    <NodeViewWrapper
      as="span"
      className={`ch-html-inline${selected ? ' is-selected' : ''}`}
      title={labels.htmlInlineLabel}
      contentEditable={false}
    >
      {String(node.attrs.html ?? '')}
    </NodeViewWrapper>
  );
}

function ToggleView({ node, editor, getPos, updateAttributes }: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  const editable = useIsEditable(editor);
  const bodyId = useId();
  const summary = typeof node.attrs.summary === 'string' ? node.attrs.summary : '';
  const level = typeof node.attrs.level === 'number' ? node.attrs.level : undefined;
  // Starts closed, except a new (empty) toggle so the author can type into it.
  const [open, setOpen] = useState(() => {
    const first = node.firstChild;
    return node.childCount === 1 && first !== null && first.isTextblock && first.content.size === 0;
  });

  // Follow the caret: moving into the closed body (keyboard, search) opens it.
  useEffect(() => {
    const onSelection = () => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      const { from } = editor.state.selection;
      const current = editor.state.doc.nodeAt(pos);
      if (current && from > pos && from < pos + current.nodeSize) setOpen(true);
    };
    editor.on('selectionUpdate', onSelection);
    return () => {
      editor.off('selectionUpdate', onSelection);
    };
  }, [editor, getPos]);

  /** Opens the body and puts the caret at its start. */
  const enterBody = () => {
    setOpen(true);
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .command(({ tr }) => {
        tr.setSelection(Selection.near(tr.doc.resolve(pos + 1)));
        return true;
      })
      .run();
  };

  return (
    <NodeViewWrapper className="ch-toggle" data-open={open ? 'true' : 'false'} data-level={level}>
      <div className="ch-toggle-head" contentEditable={false}>
        <button
          type="button"
          className="ch-icon-btn ch-toggle-btn"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={labels.slashToggle}
          title={labels.slashToggle}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="chevron" size={14} />
        </button>
        {editable ? (
          <input
            className="ch-toggle-summary"
            value={summary}
            placeholder={labels.toggleSummaryPlaceholder}
            aria-label={labels.toggleSummaryPlaceholder}
            onChange={(e) => updateAttributes({ summary: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                enterBody();
              }
            }}
          />
        ) : (
          <span
            className="ch-toggle-summary"
            {...(level ? { role: 'heading', 'aria-level': level } : {})}
            onClick={() => setOpen((o) => !o)}
          >
            {summary}
          </span>
        )}
      </div>
      <NodeViewContent className="ch-toggle-body" id={bodyId} />
    </NodeViewWrapper>
  );
}

function EmbedView({ node, selected }: ReactNodeViewProps): JSX.Element {
  const { labels, renderEmbed } = useEditorUi();
  const attrs: EmbedAttrs = {
    nodeId: typeof node.attrs.nodeId === 'string' ? node.attrs.nodeId : '',
    nodeType: str(node.attrs.nodeType),
  };
  const preview = renderEmbed?.(attrs);
  return (
    <NodeViewWrapper
      className={`ch-embed${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      data-drag-handle=""
      data-node-type={attrs.nodeType ?? undefined}
    >
      {preview ?? (
        <div className="ch-embed-card">
          <span className="ch-embed-icon">
            <Icon name="embed" size={16} />
          </span>
          <span className="ch-embed-label">{labels.embedLabel}</span>
          {attrs.nodeType ? <span className="ch-embed-type">{attrs.nodeType}</span> : null}
          <code className="ch-embed-id">{attrs.nodeId}</code>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/**
 * Whether the caret is right after this atom: a new, empty block asks for its content from the
 * person who just added it, not from others on the page.
 */
const justInserted = (
  editor: ReactNodeViewProps['editor'],
  pos: number | undefined,
  size: number,
) => typeof pos === 'number' && Math.abs(editor.state.selection.from - (pos + size)) <= 2;

let katexModule: Promise<typeof Katex> | null = null;

/** KaTeX and its fonts load with the first formula a page has. */
const loadKatex = () =>
  (katexModule ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    ([module]) => module.default,
  ));

function MathView({
  node,
  editor,
  getPos,
  selected,
  updateAttributes,
}: ReactNodeViewProps): JSX.Element {
  const { labels } = useEditorUi();
  const editable = useIsEditable(editor);
  const display = node.type.name === 'mathBlock';
  const latex = str(node.attrs.latex) ?? '';
  const [drawn, setDrawn] = useState<{ latex: string; html: string } | null>(null);
  // The last drawing stays while the next one loads, so typing does not flicker.
  const html = latex ? drawn?.html : null;
  const [editing, setEditing] = useState(
    () => editable && !latex && justInserted(editor, getPos(), node.nodeSize),
  );

  useEffect(() => {
    if (!latex) return undefined;
    let current = true;
    void loadKatex().then((katex) => {
      if (!current) return;
      // Links and other active commands stay off (`trust`); a mistake shows in red, escaped.
      setDrawn({
        latex,
        html: katex.renderToString(latex, {
          displayMode: display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
        }),
      });
    });
    return () => {
      current = false;
    };
  }, [latex, display]);

  const finish = () => {
    setEditing(false);
    const pos = getPos();
    if (typeof pos !== 'number') return;
    // The document, not this render: the last keystroke may not have reached the view yet.
    const current = editor.state.doc.nodeAt(pos);
    if (!current) return;
    if (!String(current.attrs.latex ?? '').trim()) {
      editor.view.dispatch(editor.state.tr.delete(pos, pos + current.nodeSize));
      editor.commands.focus(undefined, { scrollIntoView: false });
      return;
    }
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .command(({ tr }) => {
        tr.setSelection(Selection.near(tr.doc.resolve(pos + node.nodeSize)));
        return true;
      })
      .run();
  };

  return (
    <NodeViewWrapper
      as={display ? 'div' : 'span'}
      className={`ch-math${display ? ' ch-math--block' : ''}${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      data-drag-handle={display ? '' : undefined}
    >
      {html ? (
        <span
          className="ch-math-output"
          onClick={editable ? () => setEditing(true) : undefined}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : latex ? (
        <code className="ch-math-source">{latex}</code>
      ) : editable ? (
        <button type="button" className="ch-math-empty" onClick={() => setEditing(true)}>
          {labels.mathEmpty}
        </button>
      ) : null}
      {editable && editing ? (
        <span className="ch-editor-layer ch-math-panel">
          <textarea
            autoFocus
            rows={display ? 3 : 1}
            className="ch-math-input"
            spellCheck={false}
            dir="ltr"
            value={latex}
            placeholder={labels.mathPlaceholder}
            aria-label={labels.mathPlaceholder}
            onChange={(e) => updateAttributes({ latex: e.target.value })}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                finish();
              }
            }}
          />
        </span>
      ) : null}
    </NodeViewWrapper>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function BookmarkView({
  node,
  editor,
  getPos,
  selected,
  updateAttributes,
  deleteNode,
}: ReactNodeViewProps): JSX.Element {
  const { labels, previewLink } = useEditorUi();
  const editable = useIsEditable(editor);
  const url = str(node.attrs.url);
  const title = str(node.attrs.title);
  const favicon = str(node.attrs.favicon);
  const [autoFocus] = useState(() => justInserted(editor, getPos(), node.nodeSize));
  const [iconFailed, setIconFailed] = useState(false);

  const submit = (next: string) => {
    updateAttributes({ url: next });
    void previewLink?.(next).then(
      (meta) => updateAttributes({ title: meta.title, favicon: meta.faviconUrl }),
      () => undefined,
    );
  };

  const safe = url ? webUrl(url) : null;
  return (
    <NodeViewWrapper
      className={`ch-bookmark${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      data-drag-handle=""
    >
      {safe ? (
        <a className="ch-bookmark-card" href={safe} target="_blank" rel="noopener noreferrer">
          {favicon && webUrl(favicon) && !iconFailed ? (
            <img
              className="ch-bookmark-icon"
              src={favicon}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <Icon name="link" size={16} />
          )}
          <span className="ch-bookmark-text">
            <span className="ch-bookmark-title">{title ?? hostOf(safe)}</span>
            <span className="ch-bookmark-host">{hostOf(safe)}</span>
          </span>
        </a>
      ) : editable ? (
        <UrlPrompt
          placeholder={labels.bookmarkPlaceholder}
          autoFocus={autoFocus}
          onSubmit={submit}
          onCancel={deleteNode}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

function VideoView({
  node,
  editor,
  getPos,
  selected,
  updateAttributes,
  deleteNode,
}: ReactNodeViewProps): JSX.Element {
  const { labels, resolveMediaUrl } = useEditorUi();
  const editable = useIsEditable(editor);
  const src = str(node.attrs.src);
  const title = str(node.attrs.title);
  const [autoFocus] = useState(() => justInserted(editor, getPos(), node.nodeSize));
  // Nothing is asked of the video's site until the person presses play.
  const [playing, setPlaying] = useState(false);
  const source = src ? videoSource(src) : null;
  const web = src ? webUrl(src) : null;

  return (
    <NodeViewWrapper
      className={`ch-video${selected ? ' is-selected' : ''}`}
      contentEditable={false}
      data-drag-handle=""
    >
      {source?.kind === 'player' ? (
        playing ? (
          <iframe
            className="ch-video-frame"
            src={`${source.url}?autoplay=1`}
            title={title ?? labels.slashVideo}
            loading="lazy"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          />
        ) : (
          <button
            type="button"
            className="ch-video-frame ch-video-poster"
            aria-label={`${labels.videoPlay}: ${title ?? hostOf(src ?? '')}`}
            onClick={() => setPlaying(true)}
          >
            <span className="ch-video-play">
              <Icon name="play" size={22} />
            </span>
            <span className="ch-video-host">{title ?? hostOf(src ?? '')}</span>
          </button>
        )
      ) : source?.kind === 'file' ? (
        <video
          className="ch-video-file"
          controls
          playsInline
          preload="metadata"
          src={resolveMediaUrl ? resolveMediaUrl(source.src) : source.src}
          title={title ?? undefined}
        />
      ) : web ? (
        <a className="ch-bookmark-card" href={web} target="_blank" rel="noopener noreferrer">
          <Icon name="link" size={16} />
          <span className="ch-bookmark-text">
            <span className="ch-bookmark-title">{title ?? hostOf(web)}</span>
            <span className="ch-bookmark-host">{labels.videoUnsupported}</span>
          </span>
        </a>
      ) : editable ? (
        <VideoSourcePrompt
          autoFocus={autoFocus}
          onSource={(next) => updateAttributes(next)}
          onCancel={deleteNode}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

/** An empty video block: a link, a file from the computer or one from the host's files. */
function VideoSourcePrompt({
  autoFocus,
  onSource,
  onCancel,
}: {
  autoFocus: boolean;
  onSource: (video: { src: string; title?: string | null }) => void;
  onCancel: () => void;
}): JSX.Element {
  const { labels, uploadVideo, pickVideo, onUploadError } = useEditorUi();
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const take = async (work: () => Promise<PickedVideo | null>) => {
    setBusy(true);
    try {
      const video = await work();
      if (video) onSource(video);
    } catch {
      onUploadError?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ch-video-empty">
      <UrlPrompt
        placeholder={labels.videoPlaceholder}
        autoFocus={autoFocus}
        onSubmit={(url) => onSource({ src: url })}
        onCancel={onCancel}
      />
      {uploadVideo || pickVideo ? (
        <div className="ch-video-pick">
          {busy ? (
            <span role="status">{labels.videoUploading}</span>
          ) : (
            <>
              {uploadVideo ? (
                <>
                  <button
                    type="button"
                    className="ch-video-pick-btn"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Icon name="upload" size={14} />
                    {labels.videoPickFile}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="video/*"
                    hidden
                    tabIndex={-1}
                    data-testid="ch-video-file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void take(() => uploadVideo(file));
                    }}
                  />
                </>
              ) : null}
              {pickVideo ? (
                <button
                  type="button"
                  className="ch-video-pick-btn"
                  onClick={() => void take(pickVideo)}
                >
                  <Icon name="folder" size={14} />
                  {labels.videoPickDrive}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** React node views for `createExtensions({ nodeViews })`. */
export function createNodeViews(): Record<ViewNodeName, NodeViewRenderer> {
  return {
    admonition: ReactNodeViewRenderer(AdmonitionView),
    tabs: ReactNodeViewRenderer(TabsView),
    mermaid: ReactNodeViewRenderer(MermaidView),
    codeBlock: ReactNodeViewRenderer(CodeBlockView),
    truncate: ReactNodeViewRenderer(TruncateView),
    toc: ReactNodeViewRenderer(TocView),
    unknownBlock: ReactNodeViewRenderer(UnknownBlockView),
    htmlBlock: ReactNodeViewRenderer(HtmlBlockView, {
      stopEvent: ({ event }) => event.target instanceof HTMLTextAreaElement,
    }),
    htmlInline: ReactNodeViewRenderer(HtmlInlineView),
    toggle: ReactNodeViewRenderer(ToggleView),
    embed: ReactNodeViewRenderer(EmbedView),
    mathBlock: ReactNodeViewRenderer(MathView),
    mathInline: ReactNodeViewRenderer(MathView),
    bookmark: ReactNodeViewRenderer(BookmarkView),
    video: ReactNodeViewRenderer(VideoView),
  };
}
