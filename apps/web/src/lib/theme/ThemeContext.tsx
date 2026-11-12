import {
  applyOrgTheme,
  applyScheme,
  buildThemeCss,
  resolveScheme,
  type Appearance,
  type OrgThemeInput,
} from '@crewhall/ui/theme';
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { sharedContext } from '@/lib/sharedContext';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

/**
 * Appearance is the user's choice (system / light / dark) and a few display preferences
 * (doc 19 · 19.19). Colors come from the org theme, never from the user.
 */

export type Density = 'comfortable' | 'compact';
export type FontScale = 90 | 100 | 110 | 125;

interface ThemeValue {
  appearance: Appearance;
  scheme: 'light' | 'dark';
  setAppearance: (a: Appearance) => void;
  density: Density | null;
  setDensity: (d: Density | null) => void;
  reducedMotion: boolean;
  setReducedMotion: (v: boolean) => void;
  fontScale: FontScale;
  setFontScale: (v: FontScale) => void;
}

// Shared through globalThis like the i18n context (route chunks loaded later find it, H1).
const ThemeContext = sharedContext<ThemeValue | null>('crewhall.theme', null);

const prefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

function readAppearance(): Appearance {
  const v = readStorage(StorageKey.appearance);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(readAppearance);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);
  const [density, setDensityState] = useState<Density | null>(() => {
    const v = readStorage(StorageKey.density);
    return v === 'compact' || v === 'comfortable' ? v : null;
  });
  const [reducedMotion, setReducedMotionState] = useState(
    () => readStorage(StorageKey.reducedMotion) === '1',
  );
  const [fontScale, setFontScaleState] = useState<FontScale>(() => {
    const v = Number(readStorage(StorageKey.fontScale));
    return v === 90 || v === 110 || v === 125 ? v : 100;
  });

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const scheme = resolveScheme(appearance, systemDark);

  useEffect(() => {
    applyScheme(scheme);
  }, [scheme]);

  useEffect(() => {
    const root = document.documentElement;
    if (density) root.dataset.userDensity = density;
    else delete root.dataset.userDensity;
    if (density) root.dataset.density = density;
  }, [density]);

  useEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? 'reduced' : 'full';
  }, [reducedMotion]);

  useEffect(() => {
    document.documentElement.style.fontSize = fontScale === 100 ? '' : `${fontScale}%`;
  }, [fontScale]);

  const setAppearance = useCallback((a: Appearance) => {
    writeStorage(StorageKey.appearance, a);
    setAppearanceState(a);
  }, []);
  const setDensity = useCallback((d: Density | null) => {
    writeStorage(StorageKey.density, d);
    setDensityState(d);
  }, []);
  const setReducedMotion = useCallback((v: boolean) => {
    writeStorage(StorageKey.reducedMotion, v ? '1' : null);
    setReducedMotionState(v);
  }, []);
  const setFontScale = useCallback((v: FontScale) => {
    writeStorage(StorageKey.fontScale, String(v));
    setFontScaleState(v);
  }, []);

  const value = useMemo(
    () => ({
      appearance,
      scheme,
      setAppearance,
      density,
      setDensity,
      reducedMotion,
      setReducedMotion,
      fontScale,
      setFontScale,
    }),
    [
      appearance,
      scheme,
      setAppearance,
      density,
      setDensity,
      reducedMotion,
      setReducedMotion,
      fontScale,
      setFontScale,
    ],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/** Apply the published org theme and cache its CSS so the next load paints with it. */
export function applyPublishedTheme(theme: OrgThemeInput): void {
  applyOrgTheme(theme);
  const userDensity = document.documentElement.dataset.userDensity;
  if (userDensity) document.documentElement.dataset.density = userDensity;
  writeStorage(StorageKey.themeCss, buildThemeCss(theme));
}
