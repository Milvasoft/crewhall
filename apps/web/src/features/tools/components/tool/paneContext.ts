// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/paneContext.ts. See THIRD_PARTY.md.
import { createContext, useContext } from 'react';

/**
 * Controls a single pane exposes to whatever card it wraps. Provided by
 * {@link ResizableSplit} so a card (e.g. ToolEditor) can render its own collapse
 * button that folds the pane away, without the card needing to know about the
 * surrounding split layout.
 */
export interface PaneControls {
  /** Collapse this pane to a thin strip; the sibling pane takes the space. */
  collapse: () => void;
}

export const PaneContext = createContext<PaneControls | null>(null);

/** Returns the enclosing pane's controls, or null when not inside a split. */
export const usePane = (): PaneControls | null => useContext(PaneContext);
