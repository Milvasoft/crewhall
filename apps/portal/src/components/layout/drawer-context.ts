'use client';

import { createContext, useContext } from 'react';

/** Closes the mobile navbar drawer (no-op outside it). */
export const DrawerContext = createContext<() => void>(() => undefined);

export const useCloseDrawer = () => useContext(DrawerContext);
