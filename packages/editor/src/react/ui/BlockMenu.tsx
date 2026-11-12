import type { Editor } from '@tiptap/core';
import { useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { BLOCK_HUES, MAX_COLUMNS, type BlockColor, type BlockHue } from '../../model';
import {
  addColumn,
  BLOCK_KINDS,
  blockColor,
  blockKind,
  canColor,
  canTurnInto,
  canTurnIntoToggle,
  colorBlock,
  copyBlock,
  deleteBlock,
  duplicateBlock,
  hasBlockRange,
  moveBlock,
  selectionKind,
  TOGGLE_LEVELS,
  toggleLevel,
  turnBlockInto,
  turnBlockIntoToggle,
  turnSelectionInto,
  type BlockAt,
  type BlockKind,
  type ToggleLevel,
} from '../extensions/blocks';
import type { EditorLabels } from '../labels';
import { Icon } from './icons';

const GAP = 6;

export const HUE_LABEL: Record<BlockHue, keyof EditorLabels> = {
  gray: 'colorGray',
  red: 'colorRed',
  orange: 'colorOrange',
  yellow: 'colorYellow',
  green: 'colorGreen',
  blue: 'colorBlue',
  purple: 'colorPurple',
};

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const KIND_UI: Record<BlockKind, { icon: string; label: keyof EditorLabels }> = {
  paragraph: { icon: 'text', label: 'slashText' },
  heading1: { icon: 'h1', label: 'slashHeading1' },
  heading2: { icon: 'h2', label: 'slashHeading2' },
  heading3: { icon: 'h3', label: 'slashHeading3' },
  bulletList: { icon: 'bulletList', label: 'slashBulletList' },
  orderedList: { icon: 'orderedList', label: 'slashOrderedList' },
  taskList: { icon: 'taskList', label: 'slashTaskList' },
  blockquote: { icon: 'quote', label: 'slashQuote' },
  codeBlock: { icon: 'codeBlock', label: 'slashCodeBlock' },
};

const toggleLabel = (level: ToggleLevel): keyof EditorLabels =>
  level ? `slashToggleHeading${level}` : 'slashToggle';

/**
 * The drag handle's menu (click on ⋮⋮): move up / down, copy, duplicate, delete, color and
 * "turn into".
 * Arrow keys move between items, Escape closes and gives the focus back to the editor.
 */
export function BlockMenu({
  editor,
  block,
  anchor,
  labels,
  turnIntoOnly = false,
  onClose,
}: {
  editor: Editor;
  block: BlockAt;
  anchor: DOMRect;
  labels: EditorLabels;
  /** Only "turn into" (from the selection toolbar and the "/" menu). */
  turnIntoOnly?: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const height = el.offsetHeight;
    setAbove(anchor.bottom + GAP + height > window.innerHeight && anchor.top - GAP - height > 0);
    el.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [anchor]);

  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  const { state } = editor;
  const $pos = state.doc.resolve(block.pos);
  const index = $pos.index();
  // A selection the block is part of changes as a whole.
  const { from, to } = state.selection;
  const wholeSelection =
    hasBlockRange(state) && block.pos < to && block.pos + block.node.nodeSize > from;
  const current = wholeSelection ? selectionKind(state) : blockKind(block, state);
  const turn = (kind: BlockKind) =>
    wholeSelection ? turnSelectionInto(editor, kind) : turnBlockInto(editor, block, kind);
  const keys = isMac() ? { alt: '⌥', shift: '⇧' } : { alt: 'Alt+', shift: 'Shift+' };
  const run = (action: () => boolean) => {
    action();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? items[0] : items.at(-1))?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  };

  const color = blockColor(block);
  const swatch = (key: string, label: string, value: BlockColor | null) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={color === value}
      aria-label={label}
      title={label}
      tabIndex={-1}
      className="ch-block-swatch"
      data-swatch={value ?? 'default'}
      onClick={() => run(() => colorBlock(editor, block, value))}
    >
      {value?.endsWith('-bg') ? null : 'A'}
    </button>
  );

  const item = (
    key: string,
    icon: string,
    label: string,
    action: () => boolean,
    opts: { disabled?: boolean; checked?: boolean; danger?: boolean; shortcut?: string } = {},
  ) => (
    <button
      key={key}
      type="button"
      role={opts.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={opts.checked}
      disabled={opts.disabled}
      tabIndex={-1}
      className={['ch-block-item', opts.danger ? 'is-danger' : ''].filter(Boolean).join(' ')}
      onClick={() => run(action)}
    >
      <Icon name={icon} size={16} />
      <span>{label}</span>
      {opts.shortcut ? (
        <kbd className="ch-block-shortcut" aria-hidden="true">
          {opts.shortcut}
        </kbd>
      ) : null}
      {opts.checked ? (
        <span className="ch-block-check">
          <Icon name="check" size={14} />
        </span>
      ) : null}
    </button>
  );

  // One block at a time: the summary of a toggle holds one line.
  const toToggle = !wholeSelection && canTurnIntoToggle(block, state);
  const turnInto =
    wholeSelection || canTurnInto(block) || toToggle ? (
      <div role="group" aria-label={labels.blockTurnInto} className="ch-block-group">
        <div className="ch-block-heading" aria-hidden="true">
          {labels.blockTurnInto}
        </div>
        {wholeSelection || canTurnInto(block)
          ? BLOCK_KINDS.map((kind) =>
              item(kind, KIND_UI[kind].icon, labels[KIND_UI[kind].label], () => turn(kind), {
                checked: current === kind,
              }),
            )
          : null}
        {toToggle
          ? TOGGLE_LEVELS.map((level) =>
              item(
                `toggle${level ?? ''}`,
                'toggle',
                labels[toggleLabel(level)],
                () => turnBlockIntoToggle(editor, block, level),
                { checked: toggleLevel(block) === level },
              ),
            )
          : null}
      </div>
    ) : null;

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={turnIntoOnly ? labels.blockTurnInto : labels.blockMenu}
      className="ch-editor-layer ch-block-menu"
      style={{
        position: 'absolute',
        left: anchor.left + window.scrollX,
        top: above ? anchor.top + window.scrollY - GAP : anchor.bottom + window.scrollY + GAP,
        transform: above ? 'translateY(-100%)' : undefined,
      }}
      onKeyDown={onKeyDown}
    >
      {turnIntoOnly ? turnInto : null}
      {turnIntoOnly ? null : (
        <>
          {item('up', 'arrowUp', labels.blockMoveUp, () => moveBlock(editor, block, -1), {
            disabled: index === 0,
            shortcut: `${keys.alt}${keys.shift}↑`,
          })}
          {item('down', 'arrowDown', labels.blockMoveDown, () => moveBlock(editor, block, 1), {
            disabled: index >= $pos.parent.childCount - 1,
            shortcut: `${keys.alt}${keys.shift}↓`,
          })}
          {item('copy', 'copy', labels.blockCopy, () => copyBlock(editor, block))}
          {item('duplicate', 'duplicate', labels.blockDuplicate, () =>
            duplicateBlock(editor, block),
          )}
          {item('delete', 'trash', labels.blockDelete, () => deleteBlock(editor, block), {
            danger: true,
          })}
          {block.node.type.name === 'columns'
            ? item('addColumn', 'columns', labels.blockAddColumn, () => addColumn(editor, block), {
                disabled: block.node.childCount >= MAX_COLUMNS,
              })
            : null}
          {turnInto}
          {canColor(block, state) ? (
            <div role="group" aria-label={labels.blockColor} className="ch-block-group">
              <div className="ch-block-heading" aria-hidden="true">
                {labels.blockColor}
              </div>
              <div role="group" aria-label={labels.blockColorText} className="ch-block-swatches">
                {swatch('default', labels.blockColorDefault, null)}
                {BLOCK_HUES.map((hue) => swatch(hue, labels[HUE_LABEL[hue]], hue))}
              </div>
              <div
                role="group"
                aria-label={labels.blockColorBackground}
                className="ch-block-swatches"
              >
                {BLOCK_HUES.map((hue) => swatch(`${hue}-bg`, labels[HUE_LABEL[hue]], `${hue}-bg`))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
  return createPortal(menu, document.body);
}
