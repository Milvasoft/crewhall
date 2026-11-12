import { findParentNode, type Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection, selectionCell, TableMap } from '@tiptap/pm/tables';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  BLOCK_HUES,
  imageWidth,
  isBlockColor,
  isImageAlign,
  type BlockColor,
  type CellAlign,
  type ImageAlign,
} from '../../model';
import type { EditorLabels } from '../labels';
import { HUE_LABEL } from './BlockMenu';
import { Icon } from './icons';

function ToolButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`ch-tool${active ? ' is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active ?? undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

function Bar({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="ch-editor-layer ch-toolbar" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

/** Text color and highlight of the selection: the block menu's swatches. */
function ColorPanel({
  labels,
  current,
  onPick,
  onClose,
}: {
  labels: EditorLabels;
  current: BlockColor | null;
  onPick: (color: BlockColor | null) => void;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const swatch = (key: string, label: string, value: BlockColor | null) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={current === value}
      aria-label={label}
      title={label}
      className="ch-block-swatch"
      data-swatch={value ?? 'default'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(value)}
    >
      {value?.endsWith('-bg') ? null : 'A'}
    </button>
  );
  return (
    <div className="ch-color-panel">
      <div role="radiogroup" aria-label={labels.blockColorText} className="ch-block-swatches">
        {swatch('default', labels.blockColorDefault, null)}
        {BLOCK_HUES.map((hue) => swatch(hue, labels[HUE_LABEL[hue]], hue))}
      </div>
      <div role="radiogroup" aria-label={labels.blockColorBackground} className="ch-block-swatches">
        {BLOCK_HUES.map((hue) => swatch(`${hue}-bg`, labels[HUE_LABEL[hue]], `${hue}-bg`))}
      </div>
    </div>
  );
}

/**
 * Bold, italic, strike, inline code and link for a text selection, then the host's `actions`.
 * `actionsOnly`: a read-only editor, only the host actions are shown.
 */
export function SelectionToolbar({
  editor,
  labels,
  actions,
  actionsOnly = false,
  onTurnInto,
  textColor = false,
}: {
  editor: Editor;
  labels: EditorLabels;
  actions?: ReactNode;
  actionsOnly?: boolean;
  /** Offers text color and highlight (the `color` mark; markdown does not keep it). */
  textColor?: boolean;
  /** Opens "turn into" for the selection, under the button. */
  onTurnInto?: (anchor: DOMRect) => void;
}): JSX.Element {
  const marks = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      href: String(e.getAttributes('link').href ?? ''),
      color: e.getAttributes('color').color as unknown,
    }),
  });
  const color = isBlockColor(marks.color) ? marks.color : null;
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const closeColors = useCallback(() => setColorOpen(false), []);
  const pluginKey = actionsOnly ? 'chSelectionActions' : 'chSelectionToolbar';
  // A host action ends the selection's toolbar: the menu would otherwise stay open when the
  // action moves focus elsewhere (it ignores blur after a click inside it).
  const hostActions = actions ? (
    <span
      className="ch-toolbar-actions"
      onClick={() => {
        if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'hide'));
      }}
    >
      {actions}
    </span>
  ) : null;

  const applyColor = (next: BlockColor | null) => {
    const chain = editor.chain().focus();
    if (next) chain.setMark('color', { color: next }).run();
    else chain.unsetMark('color').run();
    setColorOpen(false);
  };

  const applyLink = (href: string) => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (url) chain.setLink({ href: url }).run();
    else chain.unsetLink().run();
    setLinkDraft(null);
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={pluginKey}
      options={{
        placement: 'top',
        offset: 8,
        onHide: () => {
          setLinkDraft(null);
          setColorOpen(false);
        },
      }}
      shouldShow={({ editor: e, view, element, state, from, to }) => {
        if (e.isEditable === actionsOnly || from === to) return false;
        // Hidden once the person moves on (e.g. into a form next to the editor); the toolbar's
        // own link input keeps it open.
        const doc = view.dom.ownerDocument;
        const domSel = doc.getSelection();
        const inEditor = domSel?.anchorNode ? view.dom.contains(domSel.anchorNode) : false;
        if (!inEditor && !element.contains(doc.activeElement)) return false;
        const sel = state.selection;
        if (sel instanceof NodeSelection || sel instanceof CellSelection) return false;
        return !sel.$from.parent.type.spec.code;
      }}
    >
      <Bar label={labels.toolbar}>
        {actionsOnly ? (
          hostActions
        ) : colorOpen ? (
          <ColorPanel labels={labels} current={color} onPick={applyColor} onClose={closeColors} />
        ) : linkDraft === null ? (
          <>
            {onTurnInto ? (
              <>
                <button
                  type="button"
                  className="ch-tool ch-tool-turn"
                  title={labels.blockTurnInto}
                  aria-label={labels.blockTurnInto}
                  aria-haspopup="menu"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => onTurnInto(e.currentTarget.getBoundingClientRect())}
                >
                  <Icon name="text" />
                  <span className="ch-tool-caret">
                    <Icon name="chevron" size={12} />
                  </span>
                </button>
                <span className="ch-toolbar-sep" />
              </>
            ) : null}
            <ToolButton
              label={labels.bold}
              icon="bold"
              active={marks.bold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            />
            <ToolButton
              label={labels.italic}
              icon="italic"
              active={marks.italic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            />
            <ToolButton
              label={labels.strike}
              icon="strike"
              active={marks.strike}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            />
            <ToolButton
              label={labels.code}
              icon="code"
              active={marks.code}
              onClick={() => editor.chain().focus().toggleCode().run()}
            />
            {textColor ? (
              <button
                type="button"
                className="ch-tool ch-tool-color"
                title={labels.blockColor}
                aria-label={labels.blockColor}
                aria-haspopup="true"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setColorOpen(true)}
              >
                <span className="ch-block-swatch" data-swatch={color ?? 'default'}>
                  A
                </span>
              </button>
            ) : null}
            <span className="ch-toolbar-sep" />
            <ToolButton
              label={labels.link}
              icon="link"
              active={marks.link}
              onClick={() => setLinkDraft(marks.href)}
            />
            {hostActions ? (
              <>
                <span className="ch-toolbar-sep" />
                {hostActions}
              </>
            ) : null}
          </>
        ) : (
          <form
            className="ch-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              applyLink(linkDraft);
            }}
          >
            <input
              className="ch-link-input"
              type="text"
              inputMode="url"
              autoFocus
              value={linkDraft}
              placeholder={labels.linkPlaceholder}
              aria-label={labels.linkPlaceholder}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setLinkDraft(null);
                  editor.commands.focus();
                }
              }}
            />
            <button
              type="submit"
              className="ch-tool"
              title={labels.linkApply}
              aria-label={labels.linkApply}
            >
              <Icon name="check" />
            </button>
            {marks.link ? (
              <ToolButton label={labels.linkRemove} icon="unlink" onClick={() => applyLink('')} />
            ) : null}
          </form>
        )}
      </Bar>
    </BubbleMenu>
  );
}

const IMAGE_WIDTHS = [25, 50, 75, 100] as const;

/** Changes the selected image; the selection stays on it. */
function setImageLayout(
  editor: Editor,
  attrs: { width?: number | null; align?: ImageAlign | null },
): void {
  const { selection, tr } = editor.state;
  if (!(selection instanceof NodeSelection)) return;
  for (const [key, value] of Object.entries(attrs)) tr.setNodeAttribute(selection.from, key, value);
  editor.view.dispatch(tr);
}

/** Width and alignment of the selected image. Picking the current one again clears it. */
export function ImageToolbar({
  editor,
  labels,
}: {
  editor: Editor;
  labels: EditorLabels;
}): JSX.Element {
  const image = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { selection } = e.state;
      const attrs = selection instanceof NodeSelection ? selection.node.attrs : {};
      return {
        width: imageWidth(attrs.width),
        align: isImageAlign(attrs.align) ? attrs.align : null,
      };
    },
  });
  const alignButton = (align: ImageAlign, label: string, icon: string) => (
    <ToolButton
      label={label}
      icon={icon}
      active={image.align === align}
      onClick={() => setImageLayout(editor, { align: image.align === align ? null : align })}
    />
  );
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="chImageToolbar"
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: e, state }) =>
        e.isEditable &&
        state.selection instanceof NodeSelection &&
        state.selection.node.type.name === 'image'
      }
    >
      <Bar label={labels.imageToolbar}>
        {alignButton('left', labels.tableAlignLeft, 'alignLeft')}
        {alignButton('center', labels.tableAlignCenter, 'alignCenter')}
        {alignButton('right', labels.tableAlignRight, 'alignRight')}
        <span className="ch-toolbar-sep" />
        {IMAGE_WIDTHS.map((width) => (
          <button
            key={width}
            type="button"
            className={`ch-tool ch-tool-text${image.width === width ? ' is-active' : ''}`}
            aria-label={`${labels.imageWidth} ${width}%`}
            aria-pressed={image.width === width}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setImageLayout(editor, { width: image.width === width ? null : width })}
          >
            {width}%
          </button>
        ))}
      </Bar>
    </BubbleMenu>
  );
}

/** Sets `align` on every cell of the caret's column (markdown aligns whole columns). */
function alignColumn(editor: Editor, align: CellAlign): void {
  editor
    .chain()
    .focus()
    .command(({ state, tr }) => {
      let $cell;
      try {
        $cell = selectionCell(state);
      } catch {
        return false;
      }
      const table = $cell.node(-1);
      const tableStart = $cell.start(-1);
      const map = TableMap.get(table);
      const col = map.colCount($cell.pos - tableStart);
      const cells = new Set<number>();
      for (let row = 0; row < map.height; row++) {
        const cellPos = map.map[row * map.width + col];
        if (cellPos !== undefined) cells.add(cellPos);
      }
      // Clicking the current alignment again resets it.
      const same = [...cells].every((p) => table.nodeAt(p)?.attrs.align === align);
      for (const cellPos of cells) {
        const cell = table.nodeAt(cellPos);
        if (!cell) continue;
        tr.setNodeMarkup(tableStart + cellPos, undefined, {
          ...cell.attrs,
          align: same ? null : align,
        });
      }
      return true;
    })
    .run();
}

/** Row / column actions while the caret is in a table. */
export function TableToolbar({
  editor,
  labels,
}: {
  editor: Editor;
  labels: EditorLabels;
}): JSX.Element {
  const run = (fn: (e: Editor) => boolean) => () => {
    fn(editor);
  };
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="chTableToolbar"
      options={{ placement: 'top-start', offset: 8 }}
      shouldShow={({ editor: e }) => e.isEditable && e.isActive('table')}
      getReferencedVirtualElement={() => {
        const found = findParentNode((n) => n.type.name === 'table')(editor.state.selection);
        if (!found) return null;
        const dom = editor.view.nodeDOM(found.pos);
        if (!(dom instanceof HTMLElement)) return null;
        return {
          getBoundingClientRect: () => dom.getBoundingClientRect(),
          getClientRects: () => dom.getClientRects(),
        };
      }}
    >
      <Bar label={labels.tableToolbar}>
        <ToolButton
          label={labels.tableAddRow}
          icon="rowAdd"
          onClick={run((e) => e.chain().focus().addRowAfter().run())}
        />
        <ToolButton
          label={labels.tableAddColumn}
          icon="colAdd"
          onClick={run((e) => e.chain().focus().addColumnAfter().run())}
        />
        <ToolButton
          label={labels.tableDeleteRow}
          icon="rowDelete"
          onClick={run((e) => e.chain().focus().deleteRow().run())}
        />
        <ToolButton
          label={labels.tableDeleteColumn}
          icon="colDelete"
          onClick={run((e) => e.chain().focus().deleteColumn().run())}
        />
        <span className="ch-toolbar-sep" />
        <ToolButton
          label={labels.tableAlignLeft}
          icon="alignLeft"
          onClick={() => alignColumn(editor, 'left')}
        />
        <ToolButton
          label={labels.tableAlignCenter}
          icon="alignCenter"
          onClick={() => alignColumn(editor, 'center')}
        />
        <ToolButton
          label={labels.tableAlignRight}
          icon="alignRight"
          onClick={() => alignColumn(editor, 'right')}
        />
        <span className="ch-toolbar-sep" />
        <ToolButton
          label={labels.tableDelete}
          icon="trash"
          onClick={run((e) => e.chain().focus().deleteTable().run())}
        />
      </Bar>
    </BubbleMenu>
  );
}
