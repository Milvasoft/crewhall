import { type Card, type Surface, type SurfaceSummary } from '@crewhall/shared';
import { createContext, useContext } from 'react';

export type CardConfigOf<T extends Card['type']> = Extract<Card, { type: T }>['config'];

/** What a card on the grid can do; provided by the surface page. */
export interface QuickContextValue {
  surface: Surface;
  surfaces: SurfaceSummary[];
  editing: boolean;
  canEdit: boolean;
  /** The person's own surface (pin target). */
  mySurfaceId: string | null;
  /**
   * Saves a card's config. Pass an updater to build on the latest local state: quick edits
   * in a row (a blur and a click in one tick) would otherwise overwrite each other.
   */
  updateConfig: <T extends Card['type']>(
    card: Card & { type: T },
    config: CardConfigOf<T> | ((prev: CardConfigOf<T>) => CardConfigOf<T>),
  ) => void;
  remove: (card: Card) => void;
  duplicate: (card: Card) => void;
  /** "Başka space'e taşı": the picker of allowed homes. */
  openMove: (card: Card) => void;
  pin: (card: Card, surfaceId: string) => void;
  resize: (card: Card, size: [number, number]) => void;
  detach: (card: Card) => void;
  openSettings: (card: Card) => void;
  /** "Düzenle": the link group's settings panel, else the card's edit dialog. */
  openEdit: (card: Card) => void;
  /** `sectionId` preselects the group's sub-section the request came from. */
  addLink: (opts?: { url?: string; groupCardId?: string; sectionId?: string }) => void;
}

export const QuickContext = createContext<QuickContextValue | null>(null);

export function useQuick(): QuickContextValue {
  const v = useContext(QuickContext);
  if (!v) throw new Error('QuickContext missing');
  return v;
}
