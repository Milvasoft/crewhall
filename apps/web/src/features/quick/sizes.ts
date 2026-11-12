import { type Card, type CardType } from '@crewhall/shared';

/** Grid units (2.2, "Davranış ve kurallar"): 12 columns, 84 px rows, 14 px gaps. */
export const GRID_COLS = 12;
export const ROW_HEIGHT = 84;
export const GRID_GAP = 14;

type Size = [number, number];

/** S / M / L per card type (2.7: page card 3×2, 3×3, 6×4). */
const PRESETS: Record<CardType | 'folder' | 'file', [Size, Size, Size]> = {
  link: [
    [2, 1],
    [3, 1],
    [3, 2],
  ],
  link_group: [
    [3, 2],
    [3, 4],
    [6, 4],
  ],
  note: [
    [3, 2],
    [3, 3],
    [4, 4],
  ],
  todo: [
    [3, 2],
    [3, 3],
    [4, 4],
  ],
  node: [
    [3, 2],
    [3, 3],
    [6, 4],
  ],
  board_assigned: [
    [3, 3],
    [4, 3],
    [6, 4],
  ],
  page: [
    [3, 2],
    [3, 3],
    [6, 4],
  ],
  chat: [
    [3, 3],
    [4, 4],
    [6, 5],
  ],
  meeting: [
    [3, 2],
    [4, 2],
    [4, 3],
  ],
  vault_item: [
    [2, 1],
    [3, 1],
    [4, 1],
  ],
  folder: [
    [3, 2],
    [3, 3],
    [6, 4],
  ],
  file: [
    [2, 1],
    [3, 1],
    [3, 2],
  ],
};

export function presetSizes(card: Card): [Size, Size, Size] {
  if (card.type === 'node' && card.node?.type === 'file') return PRESETS.file;
  if (card.type === 'node' && card.node?.type === 'folder') return PRESETS.folder;
  return PRESETS[card.type];
}

export function minSize(card: Card): Size {
  if (card.type === 'link' || card.type === 'vault_item') return [2, 1];
  if (card.type === 'node' && card.node?.type === 'file') return [2, 1];
  return [2, 2];
}
